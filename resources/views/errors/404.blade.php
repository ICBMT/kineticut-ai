@extends('errors.layout')

@section('code', '404 · not found')
@section('title', 'Nothing mapped at this address')

@section('body')
    <p>
        The project, node or page you asked for does not exist — it may have been deleted, or the
        link may point at a scan that has since been replaced.
    </p>
@endsection
