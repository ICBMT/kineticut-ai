@extends('errors.layout')

@section('code', '413 · payload too large')
@section('title', 'That archive is larger than this server accepts')

@section('body')
    @php
        $uploadMax = ini_get('upload_max_filesize') ?: '2M';
        $postMax = ini_get('post_max_size') ?: '8M';
    @endphp

    <p>The request was rejected by PHP before AtlasScope could read it.</p>

    <pre>upload_max_filesize = {{ $uploadMax }}
post_max_size       = {{ $postMax }}</pre>

    <div class="note">
        Raise both in <code>php.ini</code> and restart PHP — or, on the development server:
        <pre style="margin:10px 0 0">composer serve                      # 150 MB uploads
ATLAS_UPLOAD_MAX=1G composer serve  # go bigger</pre>
        (<code>php -d upload_max_filesize=… artisan serve</code> looks like it should work but does not:
        <code>artisan serve</code> spawns a child <code>php -S</code> which never sees the flag.)
    </div>
@endsection
