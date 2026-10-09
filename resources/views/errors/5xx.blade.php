@extends('errors.layout')

@section('code', '5xx · server error')
@section('title', 'Something broke on our side')

@section('body')
    <p>The request failed while it was being handled — check <code>storage/logs/laravel.log</code>.</p>
@endsection
