# Raising PHP's upload limit on your own machine

> **You probably do not need this.** AtlasScope streams large archives in ~1 MB
> pieces, and a raw request body ignores `upload_max_filesize` and
> `post_max_size` entirely — a stock 2 MB install takes a full 150 MB archive
> today, in the browser, with no configuration. This page is for when you want
> PHP's own limits raised too: single-request multipart uploads, other apps on the
> same PHP, or simply a server you fully control.

## 1. Find out what you actually have

Two questions, two commands. Run them in the project directory:

```bash
# Which php.ini is my terminal's PHP using?
php --ini

# What does the web server (the thing that receives uploads) say?
curl -s http://127.0.0.1:8000/api/atlas/capacity
```

The JSON from the second command is the truth for uploads:

```json
{
  "upload_max_filesize": "2M",
  "post_max_size": "8M",
  "max_human": "2 MB",
  "app_max_human": "150 MB",
  "constrained_by": "php"
}
```

`constrained_by: "php"` means PHP is the thing holding you back; `"app"` means
AtlasScope's own `ATLAS_MAX_ARCHIVE_BYTES` is.

You can also read it in the app: the upload card prints the live ceiling, and
re-reads it every time the page loads.

## 2. The values to set

```ini
upload_max_filesize = 150M   ; the biggest single file
post_max_size       = 160M   ; MUST be larger than upload_max_filesize
memory_limit        = 512M   ; 1G if you also run the scanner inline
max_execution_time  = 120    ; unpack + measure a large project
max_input_time      = 300    ; time allowed to receive the body
```

`post_max_size` above `upload_max_filesize` is not optional: the POST body is the
file **plus** multipart boundaries and the other form fields (name, `_token`).

Match the ceiling to AtlasScope's own limit, or raise both:

```ini
# .env
ATLAS_MAX_ARCHIVE_BYTES=157286400   # 150 MB, the default
```

## 3. Where to edit it — by setup

| Setup | File | Restart with |
|---|---|---|
| **PHP's built-in server** | nothing to edit — `php artisan atlas:serve` sets the limits on the child server itself | — |
| **Laravel Herd** (macOS/Windows) | Herd → Settings → PHP → the **php.ini** button for your version (`~/Library/Application Support/Herd/config/php/84/php.ini` on macOS) | Herd → Restart |
| **Laravel Valet** (macOS) | the Homebrew PHP ini: `/opt/homebrew/etc/php/8.4/php.ini` (Apple Silicon) or `/usr/local/etc/php/8.4/php.ini` (Intel) | `valet restart` |
| **Laravel Sail / Docker** | publish the runtime first: `sail artisan sail:publish`, then edit `docker/8.4/php.ini` (or `vendor/laravel/sail/runtimes/8.4/php.ini`) | `sail build --no-cache && sail up -d` |
| **XAMPP** (Windows) | `C:\xampp\php\php.ini` | XAMPP Control Panel → Stop/Start Apache |
| **MAMP** (macOS) | `/Applications/MAMP/conf/php8.4/php.ini` (MAMP Pro: Template → php.ini) | MAMP → Stop/Start servers |
| **Homebrew PHP + `php artisan serve`** | `$(brew --prefix)/etc/php/8.4/php.ini` — or skip it and use `composer serve` | `brew services restart php` |
| **Ubuntu / Debian (fpm)** | `/etc/php/8.4/fpm/php.ini` | `sudo systemctl restart php8.4-fpm` |
| **Ubuntu / Debian (Apache module)** | `/etc/php/8.4/apache2/php.ini` | `sudo systemctl restart apache2` |
| **Ubuntu / Debian (terminal only)** | `/etc/php/8.4/cli/php.ini` | nothing — CLI reads it per run |
| **cPanel / shared hosting** | MultiPHP INI Editor, or a `.user.ini` in `public/` | takes effect within ~5 minutes |

**The easiest option on any laptop**, if you are using `php artisan serve`:

```bash
composer serve              # 150 MB, no php.ini edits
ATLAS_UPLOAD_MAX=1G composer serve
```

That is `php artisan atlas:serve`, which passes the limits to the child `php -S`
process — the only place they matter. It works on Windows, macOS and Linux
without a shell wrapper.

### Nginx and Apache, if they are in front

```nginx
# nginx: the default is 1m, which rejects a big body before PHP sees it
client_max_body_size 200m;
```

Apache 2.4 defaults to `LimitRequestBody 0` (unlimited), so usually nothing to do;
if your host overrides it, set it back to `0` in the vhost.

## 4. Verify it worked

```bash
# 1. the terminal's PHP
php -r 'echo ini_get("upload_max_filesize"), PHP_EOL;'

# 2. the web server's PHP (this is the one that matters)
curl -s http://127.0.0.1:8000/api/atlas/capacity
```

Open the landing page: the upload card should now read *"Up to 150 MB per
archive"* with no "PHP here accepts only…" note.

**An open tab picks the change up on its own** — the page asks
`/api/atlas/capacity` on load, on window focus, and whenever you choose a file,
so there is nothing to clear and no cache to bust.

## 5. When the number does not change

Work down this list; each item is a real cause I have hit.

1. **Wrong php.ini — there are two.** `php --ini` shows the *CLI* one. A request
   served by php-fpm or Apache-mod-php uses a different file. On Debian/Ubuntu
   that is `/etc/php/8.x/fpm/php.ini`, not `/etc/php/8.x/cli/php.ini`. Trust the
   `capacity` endpoint, not the terminal.
2. **php-fpm pool overrides.** `/etc/php/8.x/fpm/pool.d/www.conf` may contain
   `php_admin_value[upload_max_filesize] = 2M`, which beats php.ini. Change it
   there.
3. **You are inside a container.** Sail, DDEV, Laradock and Docker Desktop run
   their own PHP; editing the host's php.ini changes nothing. Edit the image.
4. **`.user.ini` is cached.** If you used one, `user_ini.cache_ttl` defaults to
   300 seconds — wait, or restart the pool.
5. **You changed it but did not restart.** php-fpm reads php.ini once at start:
   `sudo systemctl restart php8.4-fpm`. The built-in server must be restarted
   too.
6. **A proxy is capping the body.** Nginx (`client_max_body_size`), Cloudflare
   (100 MB on free plans), or a hosted preview URL can reject a large body before
   PHP sees it. This is the case chunking is designed for — the pieces are ~1 MB,
   so nothing in the chain ever sees a big request.
7. **`php -d … artisan serve` never works.** `artisan serve` spawns a child
   `php -S`, and `-d` flags do not survive that jump. It looks like it worked and
   silently does nothing — use `php artisan atlas:serve` instead.

## Quick reference

```
No configuration at all ....... chunked upload, works on stock PHP
php artisan atlas:serve ....... 150 MB, no ini edits
composer serve ................ same thing
ATLAS_UPLOAD_MAX=1G ........... env override for either of the above
ATLAS_MAX_ARCHIVE_BYTES=… ..... AtlasScope's own ceiling (.env)
php --ini ..................... which ini the terminal loads
/api/atlas/capacity ........... what the web server will really accept
```
