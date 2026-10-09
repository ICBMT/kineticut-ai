<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\ReportService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class StatsController extends Controller
{
    public function __construct(private readonly ReportService $reports)
    {
        $this->middleware('auth:sanctum');
    }

    public function overview(Request $request): JsonResponse
    {
        return response()->json(['data' => $this->reports->weeklySummary($request->user())]);
    }

    public function __invoke(Request $request): JsonResponse
    {
        return response()->json(['data' => $this->reports->throughput($request->user())]);
    }
}
