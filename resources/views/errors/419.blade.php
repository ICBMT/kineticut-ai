@extends('errors.layout')

@section('code', '419 · session expired')
@section('title', 'That upload did not make it through')

@section('body')
    <p>
        The form was submitted without its security token — which almost always means
        <strong>PHP discarded the upload before Laravel ever saw it</strong>, usually because the
        archive is bigger than the server accepts.
    </p>

    @php
        $uploadMax = ini_get('upload_max_filesize') ?: '2M';
        $postMax = ini_get('post_max_size') ?: '8M';
    @endphp

    <pre>PHP configuration on this server
upload_max_filesize = {{ $uploadMax }}
post_max_size       = {{ $postMax }}</pre>

    <div class="note">
        On a real web server, raise them in <code>php.ini</code> (or a <code>.user.ini</code> / pool config)
        and restart PHP:
        <pre style="margin:10px 0 0">upload_max_filesize = 150M
post_max_size       = 160M</pre>
        Running the development server? AtlasScope ships a wrapper that gets the limits to the process
        that actually receives the body — note that <code>php -d … artisan serve</code> does <em>not</em>,
        because <code>artisan serve</code> spawns a child <code>php -S</code>:
        <pre style="margin:10px 0 0">composer serve                      # 150 MB uploads
ATLAS_UPLOAD_MAX=1G composer serve  # go bigger</pre>
    </div>

    <p style="margin-top:18px">
        You can also shrink the archive: the scanner reads your source, <code>composer.json</code> and
        <code>composer.lock</code> — it never needs <code>vendor/</code> or <code>node_modules/</code>.
    </p>

    <pre>zip -r project.zip . -x "vendor/*" -x "node_modules/*" -x ".git/*"</pre>
@endsection

@section('secondary', 'Try the sample project')
@section('secondary-href', url('/#upload'))
