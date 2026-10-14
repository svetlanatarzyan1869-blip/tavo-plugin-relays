# Серверы плагинов Светлячка для Tavo и SillyTavern

Здесь лежит исходный код всех серверов-посредников (релеев), через которые работают мои плагины. Он открыт, чтобы любой мог сам проверить, что серверы делают с ключом и перепиской: **передают дальше провайдеру и ничего не сохраняют**.

*English version below.*

## Что здесь

| Папка | Где работает | Какие плагины используют | Что получает |
|---|---|---|---|
| `pusya-bio-proxy/` | `https://pusya-bio-proxy.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Цикл и беременность (Tavo и SillyTavern), Сплетник | ключ, адрес провайдера, модель, сообщения для модели |
| `podslushano-album/` | `https://podslushano-album.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Подслушано: `/relay` (модель) и `/img/NN` (картинки стены) | для `/relay` — ключ, адрес, модель, сообщения |
| `story-relay/` | `https://story-proxy-one.vercel.app/api/relay` (Vercel) | Сюжет: варианты | ключ, адрес, модель, сообщения |
| `spletnik-meme/` | `https://spletnik-meme.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Сплетник, мем-обложка | номер шаблона мема и подписи (без ключа и переписки) |

Картинки альбома Подслушано (`public/`) сюда не выложены: это только статика, кода в них нет.

## Зачем нужен посредник

1. **Плагин не может обратиться к провайдеру напрямую.** Плагин работает внутри веб-страницы: в Tavo это встроенный браузер, в SillyTavern — вкладка браузера. Большинство провайдеров и шлюзов не разрешают запросы с веб-страниц, и браузер их блокирует (это называется CORS). Поэтому запрос отправляет сервер. SillyTavern устроена так же: её ключи ходят к провайдерам через её собственный сервер.
2. **Плагинам нужна отдельная модель**, чтобы не трогать основной чат. Своего способа обратиться ко второму провайдеру Tavo плагинам не даёт.
3. **Почему Cloudflare.** Бесплатный Vercel обрывает запрос на 60-й секунде, а «думающие» модели отвечают по 1–2 минуты. Cloudflare Workers почти не считает время ожидания ответа модели и держит соединение, пока модель думает.

## Что делает релей

- чистит ключ от символов, которые подставляет автозамена телефона;
- приводит адрес провайдера к виду `…/v1/chat/completions`;
- даёт «думающим» моделям запас токенов, иначе ответ приходит пустым;
- достаёт текст из ответов разного формата и превращает ошибки в понятный текст;
- **ходит только к адресам в интернете:** внутренние адреса (localhost, 10.x, 192.168.x, 169.254.x…) отклоняются;
- ограничивает размер запроса и `max_tokens`.

## Чего релей НЕ делает

- **Ничего не хранит.** Базы данных нет, запрос живёт только в памяти, пока идёт ответ.
- **Не пишет ключ и переписку в логи.**
  - `pusya-bio-proxy`, `story-relay` и `spletnik-meme` не пишут в лог вообще ничего (в коде нет ни одного `console.log`).
  - `podslushano-album` пишет одну строку на запрос: время, адрес провайдера, модель, код ответа, длину ответа. Если была ошибка, туда попадает её короткий текст, из которого вырезано всё, что похоже на ключ.
- **Не тратит чужие ключи.** Своих ключей у релея нет, он использует только тот, что пришёл в запросе.

Ключ хранится только у пользователя: в закрытых настройках плагина (Tavo) или в настройках расширения (SillyTavern).

## Как это проверить

- Код в этом репозитории — тот, что развёрнут по адресам выше. Cloudflare и Vercel не умеют показывать снаружи, какой код запущен, поэтому каждое изменение серверов будет появляться здесь отдельным коммитом.
- В SillyTavern можно вообще обойтись без релея: «Голос за кадром» и «Репутация» по умолчанию берут модель из подключения самой таверны, тогда ключ никуда не уходит. В Цикл для SillyTavern такой режим добавляется.
- Совет для любых плагинов со второй моделью: заведите отдельный ключ с небольшим лимитом трат.

Вопросы, ошибки, предложения: https://tavo-hub.vercel.app/feedback

---

# Relay servers for Svetlyachok's Tavo and SillyTavern plugins

This repository contains the source code of every relay server my plugins use. It is public so anyone can check what the servers do with your API key and chat: **they pass the request on to your provider and store nothing**.

*English is not my native language — if something reads oddly, I'd love to know.*

## What is here

| Folder | Runs at | Used by | Receives |
|---|---|---|---|
| `pusya-bio-proxy/` | `https://pusya-bio-proxy.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Cycle & Pregnancy (Tavo and SillyTavern), The Gossip | key, provider URL, model, messages for the model |
| `podslushano-album/` | `https://podslushano-album.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | Overheard: `/relay` (model) and `/img/NN` (wall pictures) | for `/relay`: key, provider URL, model, messages |
| `story-relay/` | `https://story-proxy-one.vercel.app/api/relay` (Vercel) | Story Paths | key, provider URL, model, messages |
| `spletnik-meme/` | `https://spletnik-meme.spletnik-meme-worker.workers.dev` (Cloudflare Workers) | The Gossip, meme cover | meme template id and captions (no key, no chat) |

## Why a relay is needed

1. **A plugin cannot call the provider directly.** Plugins run inside a web page (Tavo's built-in browser, or a SillyTavern browser tab). Most providers and gateways do not allow requests from web pages, so the browser blocks them (CORS). A server has to send the request instead — SillyTavern itself works the same way.
2. **The plugins use a separate model** so the main chat is not affected, and Tavo gives plugins no other way to reach a second provider.
3. **Why Cloudflare:** free Vercel cuts requests at 60 seconds, while thinking models often need 1–2 minutes. Cloudflare Workers barely bill the waiting time and keep the connection alive.

## What the relay does

- cleans the key from characters inserted by phone autocorrect;
- normalizes the provider URL to `…/v1/chat/completions`;
- gives thinking models enough token budget (otherwise they return an empty answer);
- extracts text from different response formats and returns readable errors;
- **only calls public internet addresses**: internal ones (localhost, 10.x, 192.168.x, 169.254.x…) are rejected;
- limits request size and `max_tokens`.

## What the relay does NOT do

- **Stores nothing.** No database; a request only lives in memory while the answer is coming.
- **Does not log your key or chat.** `pusya-bio-proxy`, `story-relay` and `spletnik-meme` log nothing at all. `podslushano-album` logs one line per request: time, provider host, model, status, answer length, plus a short error text with anything key-like removed.
- **Never spends someone else's key.** The relay has no keys of its own; it only uses the one in the request.

Feedback, bug reports and ideas: https://tavo-hub.vercel.app/feedback
