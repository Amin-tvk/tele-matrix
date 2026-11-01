# Voice message transcription

Voice and round video messages show a transcribe button. Messages are end-to-end encrypted, so the server can't
read them on its own: when someone taps the button, their app decrypts the audio and posts it to `/transcribe`
on the web host. `server/transcriber` turns it into text in memory with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) and keeps nothing.

- Model: `large-v3-turbo` (int8, CPU), about 2 GB of RAM. A small `base` model first picks the language among
  `WHISPER_LANGUAGES` (default `fa,en,ar`), which is much cheaper than the big model's own detection.
- On an 8-core Xeon E5-2680 v4 a short message takes about 20 seconds; messages are handled one at a time.
- Only signed-in accounts of the homeserver can use it (checked with `/account/whoami`), 20 messages an hour each.
- The models download from Hugging Face on first start into `/models`; set `HTTPS_PROXY` where it is filtered.

Behind the host nginx (as on tele.peyvand-yar.ir):

```nginx
location = /transcribe {
    proxy_pass http://127.0.0.1:18095;
    client_max_body_size 16M;
    proxy_read_timeout 300s;
}
```
