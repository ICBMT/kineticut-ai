@extends('errors.layout')

@section('code', '500 · server error')
@section('title', 'Something broke on our side')

@section('body')
    <p>
        The request failed while it was being handled. The details are in
        <code>storage/logs/laravel.log</code>.
    </p>

    @if (config('app.debug') && isset($exception))
        <pre>{{ class_basename($exception) }}: {{ $exception->getMessage() }}
{{ $exception->getFile() }}:{{ $exception->getLine() }}</pre>
    @endif

    @if (! config('app.debug'))
        <p>Try again, and if it keeps happening, check the log for the trace.</p>
    @endif
@endsection
