{{--
    AtlasScope error shell.

    Deliberately dependency-free: no Vite, no framework exception renderer, no
    external assets. If the application itself is broken, this page still has to
    render — that is the whole point of having it.
--}}
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>@yield('code') — AtlasScope</title>
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 32px;
            background:
                radial-gradient(1200px 800px at 15% -10%, rgba(56, 189, 248, .12), transparent 60%),
                radial-gradient(900px 700px at 90% 0%, rgba(167, 139, 250, .14), transparent 55%),
                linear-gradient(180deg, #080b14, #05070d 70%);
            color: #e8edf7;
            font: 400 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        .card {
            width: min(720px, 100%);
            border: 1px solid rgba(148, 163, 184, .18);
            border-radius: 18px;
            background: rgba(15, 20, 34, .72);
            backdrop-filter: blur(16px);
            padding: 30px;
            box-shadow: 0 30px 70px rgba(2, 6, 18, .6);
        }
        .brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; margin-bottom: 22px; }
        .brand__mark {
            width: 30px; height: 30px; border-radius: 9px;
            display: grid; place-items: center;
            background: linear-gradient(135deg, #56b8ff, #a78bfa);
        }
        .brand__name { font-weight: 650; letter-spacing: .01em; }
        .brand__sub { display: block; font-size: .68rem; letter-spacing: .16em; text-transform: uppercase; color: #6b7890; }
        .code {
            font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
            font-size: .74rem; letter-spacing: .18em; text-transform: uppercase;
            color: #56b8ff;
        }
        h1 { margin: 8px 0 10px; font-size: 1.6rem; letter-spacing: -.015em; }
        p { margin: 0 0 14px; color: #9aa7bd; }
        code, pre {
            font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
            font-size: .82rem;
        }
        pre {
            margin: 0 0 16px;
            padding: 13px 15px;
            border-radius: 11px;
            border: 1px solid rgba(148, 163, 184, .16);
            background: rgba(5, 8, 15, .7);
            color: #cfe0f5;
            overflow-x: auto;
        }
        code { color: #7dd3fc; background: rgba(86, 184, 255, .1); padding: 1px 5px; border-radius: 5px; }
        .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
        .btn {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 9px 16px; border-radius: 10px; text-decoration: none;
            font-size: .85rem; font-weight: 600; border: 1px solid transparent;
        }
        .btn--primary { background: linear-gradient(135deg, #56b8ff, #a78bfa); color: #06101f; }
        .btn--ghost { border-color: rgba(148, 163, 184, .3); color: #e8edf7; }
        .note {
            margin-top: 22px; padding: 13px 15px;
            border-radius: 11px; border: 1px dashed rgba(251, 191, 36, .4);
            background: rgba(251, 191, 36, .07); color: #fcd34d; font-size: .85rem;
        }
        .note pre { background: rgba(5, 8, 15, .5); border-color: rgba(251, 191, 36, .25); color: #fcd34d; }
    </style>
</head>
<body>
    <main class="card">
        <a class="brand" href="{{ url('/') }}">
            <span class="brand__mark">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#06101f" stroke-width="2" stroke-linejoin="round">
                    <path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>
                </svg>
            </span>
            <span>
                <span class="brand__name">AtlasScope</span>
                <small class="brand__sub">Architecture observatory</small>
            </span>
        </a>

        <div class="code">@yield('code')</div>
        <h1>@yield('title')</h1>

        @yield('body')

        <div class="actions">
            <a class="btn btn--primary" href="{{ url('/') }}">Back to projects</a>
            @hasSection('secondary')
                <a class="btn btn--ghost" href="@yield('secondary-href', url('/'))">@yield('secondary')</a>
            @endif
        </div>
    </main>
</body>
</html>
