<?php

use App\Http\Controllers\AiController;
use App\Http\Controllers\AtlasApiController;
use App\Http\Controllers\ProjectController;
use App\Http\Controllers\UploadController;
use Illuminate\Support\Facades\Route;

Route::get('/', [ProjectController::class, 'index'])->name('home');
Route::get('/projects', [ProjectController::class, 'index'])->name('projects.index');

/*
 * Chunked uploads. PHP's multipart limits (upload_max_filesize, post_max_size)
 * do not apply to a raw request body, so a large archive is streamed here in
 * ~1 MB pieces and reassembled on disk. This is why AtlasScope accepts big
 * projects on a completely stock PHP install.
 */
Route::post('/uploads', [UploadController::class, 'start'])->name('uploads.start');
Route::put('/uploads/{token}', [UploadController::class, 'chunk'])->where('token', '[A-Za-z0-9]{40}')->name('uploads.chunk');
Route::post('/uploads/{token}/complete', [UploadController::class, 'complete'])->where('token', '[A-Za-z0-9]{40}')->name('uploads.complete');
Route::delete('/uploads/{token}', [UploadController::class, 'abort'])->where('token', '[A-Za-z0-9]{40}')->name('uploads.abort');
Route::post('/projects', [ProjectController::class, 'store'])->name('projects.store');
Route::post('/projects/demo', [ProjectController::class, 'storeDemo'])->name('projects.demo');
Route::get('/projects/{project}', [ProjectController::class, 'show'])->name('projects.show');
Route::delete('/projects/{project}', [ProjectController::class, 'destroy'])->name('projects.destroy');
Route::post('/projects/{project}/rescan', [ProjectController::class, 'rescan'])->name('projects.rescan');
Route::get('/projects/{project}/atlas', [ProjectController::class, 'atlas'])->name('projects.atlas');

/*
|--------------------------------------------------------------------------
| JSON API
|--------------------------------------------------------------------------
| The UI never reloads a page to talk to the graph: everything below is data.
*/
Route::prefix('api/atlas')->name('api.atlas.')->group(function () {
    // Not project-scoped: the server's upload capacity, asked live by the browser.
    Route::get('/capacity', [AtlasApiController::class, 'capacity'])->name('capacity');
    Route::get('/projects/{project}/graph', [ProjectController::class, 'graph'])->name('graph');
    Route::get('/projects/{project}/status', [ProjectController::class, 'status'])->name('status');
    Route::get('/projects/{project}/events', [ProjectController::class, 'events'])->name('events');
    Route::get('/projects/{project}/export', [ProjectController::class, 'export'])->name('export');
    Route::get('/projects/{project}/search', [AtlasApiController::class, 'search'])->name('search');
    Route::get('/projects/{project}/neighbourhood', [AtlasApiController::class, 'neighbourhood'])->name('neighbourhood');
    Route::get('/projects/{project}/file', [AtlasApiController::class, 'file'])->name('file');
    Route::get('/projects/{project}/nodes/{key}', [AtlasApiController::class, 'node'])
        ->where('key', '.*')
        ->name('nodes');

    /*
     * The local assistant. `status` is asked as soon as the panel opens (it is
     * how the panel discovers whether anything is running), and `ask` streams
     * the answer back as it is written.
     */
    Route::get('/projects/{project}/ai/status', [AiController::class, 'status'])->name('ai.status');
    Route::post('/projects/{project}/ai/ask', [AiController::class, 'ask'])->name('ai.ask');
});
