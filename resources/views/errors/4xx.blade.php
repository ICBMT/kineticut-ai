@extends('errors.layout')

@section('code', '4xx · request rejected')
@section('title', 'That request could not be handled')

@section('body')
    <p>{{ $exception->getMessage() ?: 'The server refused the request.' }}</p>
@endsection
