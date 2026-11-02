# Topics

Groups can be split into topics, like Telegram's forums (group settings → Topics, for admins). On Matrix a topic is a
thread: its first message carries the title and icon, and every message in the topic is a thread reply to it, so
other Matrix apps show topics as threads. Messages outside any thread are the "General" topic. See
`client/src/api/matrix/forum.ts`.

- `im.peyvand.forum` (state, key `''`): `{ enabled, pinned: [root event IDs] }`, sent by admins
- `im.peyvand.topic` (state, key = the topic's first event ID): `title`, `icon_color`, `icon_emoji_id`, `creator`,
  `root_ts`, `closed`, `hidden`, `deleted`. Turning topics on lets members send it (the "create topics"
  permission); the app accepts changes only from the topic's creator or an admin
- `im.peyvand.topic_read` (room account data): how far each topic has been read, shared by the person's devices,
  since a Matrix read receipt covers the whole room. Unread counts per topic are worked out from it on the device

Deleting a topic marks it deleted and removes its first message; the messages in it stay on the server but are no
longer shown. Topic titles are room state, so the server can read them even in encrypted groups; the messages are
encrypted as usual.
