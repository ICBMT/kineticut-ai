@extends('errors.layout')

@section('code', '429 · too many requests')
@section('title', 'Slow down for a moment')

@section('body')
    <p>Too many requests have arrived from this address. Try again in a few seconds.</p>
@endsection
