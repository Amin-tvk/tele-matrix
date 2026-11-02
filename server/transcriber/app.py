"""Voice message transcription for Tele.

Voice messages are end-to-end encrypted, so the server never sees them. When someone taps "Transcribe", their
app decrypts the audio and posts it here; it is turned into text in memory and nothing is kept on disk. Only
signed-in accounts of this homeserver can use it.

POST /transcribe answers at once with a job; the app then asks GET /transcribe?job=… until the text is ready,
so a slow queue never runs into a proxy's timeout. The model is loaded on the first request and let go after a
few idle minutes, so the service costs no memory while nobody uses it.
"""
import asyncio
import gc
import hashlib
import io
import os
import secrets
import time

import aiohttp
from aiohttp import web
from faster_whisper import WhisperModel, decode_audio

HOMESERVER = os.environ.get('HOMESERVER_URL', 'http://127.0.0.1:18008')
HOMESERVER_HOST = os.environ.get('HOMESERVER_HOST', '')
# On this server's CPU "small" turns a short message around in about 5 seconds; large-v3-turbo is a little more
# accurate and three to four times slower
MODEL = os.environ.get('WHISPER_MODEL', 'small')
THREADS = int(os.environ.get('WHISPER_THREADS', '6'))
LANGUAGES = os.environ.get('WHISPER_LANGUAGES', 'fa,en,ar').split(',')
IDLE_UNLOAD_SECONDS = int(os.environ.get('WHISPER_IDLE_UNLOAD', '300'))
PORT = int(os.environ.get('PORT', '18095'))
MAX_BYTES = 15 * 1024 * 1024
TOKEN_CACHE_SECONDS = 600
# Finished text is kept in memory for a while, so asking again (or a second tap) doesn't recognize it twice
RESULT_SECONDS = 600
# One person can't keep the server busy for everyone else
PER_USER_LIMIT = 30
PER_USER_WINDOW = 3600

model: WhisperModel | None = None
last_used = 0.0
# Recognition uses every core it gets, so voice messages are transcribed one at a time
busy = asyncio.Semaphore(1)
known_tokens: dict[str, tuple[str, float]] = {}
recent_by_user: dict[str, list[float]] = {}
# job id -> {'user', 'hash', and once finished 'text' or 'error' and 'done_at'}
jobs: dict[str, dict] = {}
job_by_hash: dict[str, str] = {}


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


async def authorize(request: web.Request):
    auth = request.headers.get('Authorization', '')
    token = auth[7:] if auth.startswith('Bearer ') else ''
    return await whoami(token) if token else None


def is_over_limit(user_id: str):
    now = time.time()
    recent = [at for at in recent_by_user.get(user_id, []) if now - at < PER_USER_WINDOW]
    recent_by_user[user_id] = recent
    if len(recent) >= PER_USER_LIMIT:
        return True
    recent.append(now)
    return False


def get_model():
    global model
    if model is None:
        model = WhisperModel(MODEL, device='cpu', compute_type='int8', cpu_threads=THREADS)
    return model


def pick_language(whisper: WhisperModel, samples):
    # Only the languages people here speak, so a short or unclear message isn't read as something exotic
    _, _, probabilities = whisper.detect_language(samples)
    allowed = [(code, probability) for code, probability in probabilities if code in LANGUAGES]
    return max(allowed, key=lambda item: item[1])[0] if allowed else LANGUAGES[0]


def recognize(audio: bytes, language: str | None):
    whisper = get_model()
    samples = decode_audio(io.BytesIO(audio))
    language = language if language in LANGUAGES else pick_language(whisper, samples)
    # No carried-over context and no repeated phrases: unclear audio otherwise sends the model into a loop of the
    # same word, and every retry at a higher temperature costs a whole extra pass
    segments, _ = whisper.transcribe(
        samples, language=language, beam_size=1, vad_filter=True, without_timestamps=True,
        temperature=[0.0, 0.4], condition_on_previous_text=False, no_repeat_ngram_size=3, repetition_penalty=1.1,
    )
    return ' '.join(segment.text.strip() for segment in segments).strip()


async def run_job(job: dict, audio: bytes, language: str | None):
    global last_used
    async with busy:
        try:
            job['text'] = await asyncio.get_running_loop().run_in_executor(None, recognize, audio, language)
        except Exception as err:  # noqa: BLE001 - undecodable audio is the caller's problem, not a crash
            print('transcription failed:', type(err).__name__, flush=True)
            job['error'] = 'bad_audio'
        last_used = time.time()
    job['done_at'] = time.time()


def answer(job_id: str):
    job = jobs[job_id]
    if 'done_at' not in job:
        return web.json_response({'job': job_id, 'pending': True}, status=202)
    if job.get('error'):
        return web.json_response({'error': job['error']}, status=400)
    return web.json_response({'text': job['text']})


async def start(request: web.Request):
    user_id = await authorize(request)
    if not user_id:
        return web.json_response({'error': 'unauthorized'}, status=401)
    audio = await request.read()
    if not audio or len(audio) > MAX_BYTES:
        return web.json_response({'error': 'bad_audio'}, status=400)
    language = request.query.get('lang') or None
    # The same audio from the same person is one job, however many times the button is tapped
    audio_hash = hashlib.sha256(f'{user_id}|{language}|'.encode() + audio).hexdigest()
    existing = job_by_hash.get(audio_hash)
    if existing in jobs and not jobs[existing].get('error'):
        return answer(existing)
    if is_over_limit(user_id):
        return web.json_response({'error': 'too_many'}, status=429)
    job_id = secrets.token_urlsafe(16)
    jobs[job_id] = {'user': user_id, 'hash': audio_hash}
    job_by_hash[audio_hash] = job_id
    asyncio.get_running_loop().create_task(run_job(jobs[job_id], audio, language))
    return answer(job_id)


async def status(request: web.Request):
    user_id = await authorize(request)
    if not user_id:
        return web.json_response({'error': 'unauthorized'}, status=401)
    job_id = request.query.get('job', '')
    if job_id not in jobs or jobs[job_id]['user'] != user_id:
        return web.json_response({'error': 'not_found'}, status=404)
    return answer(job_id)


async def clean_up():
    global model
    while True:
        await asyncio.sleep(30)
        now = time.time()
        for job_id, job in list(jobs.items()):
            if 'done_at' in job and now - job['done_at'] > RESULT_SECONDS:
                del jobs[job_id]
                if job_by_hash.get(job['hash']) == job_id:
                    del job_by_hash[job['hash']]
        if model is not None and not busy.locked() and now - last_used > IDLE_UNLOAD_SECONDS:
            model = None
            gc.collect()


async def run_clean_up(app: web.Application):
    task = asyncio.get_running_loop().create_task(clean_up())
    yield
    task.cancel()


app = web.Application(client_max_size=MAX_BYTES)
app.router.add_post('/transcribe', start)
app.router.add_get('/transcribe', status)
app.router.add_get('/transcribe/health', lambda request: web.json_response({'ok': True, 'loaded': model is not None}))
app.cleanup_ctx.append(run_clean_up)

if __name__ == '__main__':
    web.run_app(app, host=os.environ.get('HOST', '127.0.0.1'), port=PORT, print=None)
