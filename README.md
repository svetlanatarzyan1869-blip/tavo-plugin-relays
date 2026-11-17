# Серверы плагинов Светлячка для Tavo

Здесь лежит исходный код серверов, к которым обращаются мои плагины. Он открыт, чтобы любой мог сам проверить, что эти серверы получают и что с этим делают.

*English version below.*

## Главное: ключ и переписка через мои серверы больше не ходят

Раньше запросы к модели шли через серверы-посредники (релеи). Теперь «Цикл и беременность», «Сплетник» и «Сюжет: варианты» обращаются к провайдеру **напрямую с твоего устройства**, а Storyline релеем не пользуется совсем. Ключ хранится в закрытых настройках плагина и уходит только к провайдеру, которого ты сама указала.

Старые релеи `pusya-bio-proxy` и `story-relay` выключены, их код убран из репозитория (он остался в истории git).

## Что ещё работает

| Папка | Где работает | Какой плагин использует | Что получает |
|---|---|---|---|
| `spletnik-meme/` | `https://spletnik-meme.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Сплетник: мем-обложка выпуска | номер шаблона мема и две подписи. Ни ключа, ни переписки |
| `podslushano-album/` | `https://podslushano-album.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Storyline: общий рейтинг (`/lb`) | имя, которое ты сама вписала для рейтинга, и счётчики. Ни ключа, ни переписки |

**Зачем мем-обложке сервер.** Плагин просит мем у memegen.link, но прямой запрос к картинке из Tavo может зависнуть. Сервер скачивает картинку сам и отдаёт её плагину целиком.

Релей к модели (`/relay`) из `podslushano-album` убран. Остался только старый адрес `/img/NN` с картинками стены для расширения «Подслушано», которое больше не поддерживается. Ни ключа, ни переписки он не получает.

## Чего эти серверы НЕ делают

- **Не получают ключ и переписку.** Их не отправляет ни один текущий плагин.
- **Не пишут лишнего в логи.** В `spletnik-meme` нет ни одного `console.log`.
- **Не тратят чужие ключи.** Своих ключей у серверов нет.

Вопросы, ошибки, предложения: https://tavo-hub.vercel.app/feedback

---

# Server code for Svetlyachok's Tavo plugins

This repository contains the source code of the servers my plugins talk to. It is public so anyone can check what these servers receive and what they do with it.

*English is not my native language — if something reads oddly, I'd love to know.*

## The main thing: your key and chat no longer pass through my servers

Model requests used to go through relay servers. Now Cycle & Pregnancy, The Gossip and Story Paths call your provider **directly from your device**, and Storyline does not use a relay at all. The key is kept in the plugin's private settings and is only sent to the provider you chose.

The old relays `pusya-bio-proxy` and `story-relay` are shut down and their code has been removed from this repository (it is still in the git history).

## What is still running

| Folder | Runs at | Used by | Receives |
|---|---|---|---|
| `spletnik-meme/` | `https://spletnik-meme.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | The Gossip: issue meme cover | meme template id and two captions. No key, no chat |
| `podslushano-album/` | `https://podslushano-album.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Storyline: shared leaderboard (`/lb`) | the name you typed for the leaderboard and counters. No key, no chat |

**Why the meme cover needs a server.** The plugin asks memegen.link for a meme, but loading that image directly inside Tavo can hang. The server downloads the image itself and hands it to the plugin in one piece.

The model relay (`/relay`) has been removed from `podslushano-album`. Only the old `/img/NN` route (wall pictures for the discontinued Overheard extension) remains; it receives no key and no chat.

## What these servers do NOT do

- **They never receive your key or chat.** No current plugin sends them.
- **They do not log more than needed.** `spletnik-meme` has no `console.log` at all.
- **They never spend anyone's key.** The servers have no keys of their own.

Feedback, bug reports and ideas: https://tavo-hub.vercel.app/feedback
