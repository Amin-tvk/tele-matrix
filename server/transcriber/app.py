"""Voice message transcription for Tele.

Voice messages are end-to-end encrypted, so the server never sees them. When someone taps "Transcribe", their
app decrypts the audio and posts it here; it is turned into text in memory and nothing is kept. Only signed-in
accounts of this homeserver can use it.
"""
import asyncio
import io
import os
import time

import aiohttp
from aiohttp import web
from faster_whisper import WhisperModel, decode_audio

HOMESERVER = os.environ.get('HOMESERVER_URL', 'http://127.0.0.1:18008')
HOMESERVER_HOST = os.environ.get('HOMESERVER_HOST', '')
MODEL = os.environ.get('WHISPER_MODEL', 'large-v3-turbo')
THREADS = int(os.environ.get('WHISPER_THREADS', '6'))
# The big model's own language detection costs as much as the transcription; a small one decides in a moment
DETECT_MODEL = os.environ.get('WHISPER_DETECT_MODEL', 'base')
LANGUAGES = os.environ.get('WHISPER_LANGUAGES', 'fa,en,ar').split(',')
PORT = int(os.environ.get('PORT', '18095'))
MAX_BYTES = 15 * 1024 * 1024
TOKEN_CACHE_SECONDS = 600
# One person can't keep the server busy for everyone else
PER_USER_LIMIT = 20
PER_USER_WINDOW = 3600

model = WhisperModel(MODEL, device='cpu', compute_type='int8', cpu_threads=THREADS)
detector = WhisperModel(DETECT_MODEL, device='cpu', compute_type='int8', cpu_threads=THREADS)
# Recognition uses every core it gets, so voice messages are transcribed one at a time
busy = asyncio.Semaphore(1)
known_tokens: dict[str, tuple[str, float]] = {}
recent_by_user: dict[str, list[float]] = {}


async def whoami(token: str):
    cached = known_tokens.get(token)
    if cached and time.time() - cached[1] < TOKEN_CACHE_SECONDS:
        return cached[0]
    headers = {'Authorization': f'Bearer {token}'}
    if HOMESERVER_HOST:
        headers['Host'] = HOMESERVER_HOST
    async with aiohttp.ClientSession() as session:
        async with session.get(f'{HOMESERVER}/_matrix/client/v3/account/whoami', headers=headers) as response:
            if response.status != 200:
                return None
            user_id = (await response.json()).get('user_id')
    if user_id:
        known_tokens[token] = (user_id, time.time())
    return user_id


def is_over_limit(user_id: str):
    now = time.time()
    recent = [at for at in recent_by_user.get(user_id, []) if now - at < PER_USER_WINDOW]
    recent_by_user[user_id] = recent
    if len(recent) >= PER_USER_LIMIT:
        return True
    recent.append(now)
    return False


def pick_language(samples):
    # Only the languages people here speak, so a short or unclear message isn't read as something exotic
    _, _, probabilities = detector.detect_language(samples)
    allowed = [(code, probability) for code, probability in probabilities if code in LANGUAGES]
    return max(allowed, key=lambda item: item[1])[0] if allowed else LANGUAGES[0]


def recognize(audio: bytes, language: str | None):
    samples = decode_audio(io.BytesIO(audio))
    language = language if language in LANGUAGES else pick_language(samples)
    segments, _ = model.transcribe(samples, language=language, beam_size=1, vad_filter=True,
                                   without_timestamps=True)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    return text, language


async def transcribe(request: web.Request):
    auth = request.headers.get('Authorization', '')
    token = auth[7:] if auth.startswith('Bearer ') else ''
    user_id = await whoami(token) if token else None
    if not user_id:
        return web.json_response({'error': 'unauthorized'}, status=401)
    if is_over_limit(user_id):
        return web.json_response({'error': 'too_many'}, status=429)
    audio = await request.read()
    if not audio or len(audio) > MAX_BYTES:
        return web.json_response({'error': 'bad_audio'}, status=400)
    language = request.query.get('lang') or None
    async with busy:
        try:
            text, detected = await asyncio.get_running_loop().run_in_executor(None, recognize, audio, language)
        except Exception as err:  # noqa: BLE001 - undecodable audio is the caller's problem, not a crash
            print('transcription failed:', type(err).__name__, flush=True)
            return web.json_response({'error': 'bad_audio'}, status=400)
    return web.json_response({'text': text, 'language': detected})


app = web.Application(client_max_size=MAX_BYTES)
app.router.add_post('/transcribe', transcribe)
app.router.add_get('/transcribe/health', lambda request: web.json_response({'ok': True}))

if __name__ == '__main__':
    web.run_app(app, host=os.environ.get('HOST', '127.0.0.1'), port=PORT, print=None)
