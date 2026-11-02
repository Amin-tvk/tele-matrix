# Voice message transcription

Voice and round video messages show a transcribe button. Messages are end-to-end encrypted, so the server can't
read them on its own: when someone taps the button, their app decrypts the audio and posts it to `/transcribe`
on the web host. `server/transcriber` turns it into text in memory with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) and keeps nothing.

- Model: `small` (int8, CPU) by default; set `WHISPER_MODEL=large-v3-turbo` for a little more accuracy at three to
  four times the time. The language is picked among `WHISPER_LANGUAGES` (default `fa,en,ar`).
- On an 8-core Xeon E5-2680 v4 a short message takes about 5 seconds with `small` (about 18 with
  `large-v3-turbo`); messages are handled one at a time.
- The model loads on the first request and is let go after `WHISPER_IDLE_UNLOAD` seconds without use (default 300),
  so the service holds about 50 MB of memory while idle.
- `POST /transcribe` answers right away with a job (202); the app asks `GET /transcribe?job=…` until the text is
  ready, so a long queue never hits a proxy timeout. The same audio from the same person is one job, and finished
  text is kept in memory for 10 minutes.
- Only signed-in accounts of the homeserver can use it (checked with `/account/whoami`), 30 messages an hour each.
- The models download from Hugging Face on first start into `/models`; set `HTTPS_PROXY` where it is filtered.

Behind the host nginx (as on tele.peyvand-yar.ir):

```nginx
location = /transcribe {
    proxy_pass http://127.0.0.1:18095;
    client_max_body_size 16M;
    proxy_read_timeout 300s;
}
```
