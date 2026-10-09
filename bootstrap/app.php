<?php

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Database\RecordsNotFoundException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );

        // An upload bigger than post_max_size arrives with its body already
        // stripped by PHP, which lands here as a 413. Say what happened and
        // what the limits are instead of showing a bare error page.
        $exceptions->render(function (PostTooLargeException $e, Request $request) {
            if ($request->expectsJson()) {
                return response()->json([
                    'message' => 'That archive is larger than this server accepts (post_max_size = '.ini_get('post_max_size').').',
                ], 413);
            }

            return response()->view('errors.413', [], 413);
        });

        /*
         * Laravel's debug error page lives inside the framework package and
         * reads its own stylesheet from vendor/. When that install is
         * incomplete the renderer throws while rendering the error that was
         * thrown while rendering — which is how a plain 419 turns into a wall
         * of "file_get_contents(): Failed to open stream".
         *
         * So: if the framework renderer is usable, leave it alone; if it is
         * not, fall back to AtlasScope's own error page.
         */
        $exceptions->render(function (Throwable $e, Request $request) {
            // This callback exists for one narrow case: a fatal exception while
            // APP_DEBUG is on and the framework's debug page cannot render. It
            // must therefore keep its hands off everything Laravel already
            // knows how to answer — validation failures, auth, 404s — or those
            // become 500s. Without debug, Laravel renders errors::500 itself.
            if ($request->expectsJson() || ! config('app.debug')) {
                return null;
            }

            $handled = [
                HttpResponseException::class,
                HttpExceptionInterface::class,
                AuthenticationException::class,
                AuthorizationException::class,
                ValidationException::class,
                ModelNotFoundException::class,
                RecordsNotFoundException::class,
            ];

            foreach ($handled as $type) {
                if ($e instanceof $type) {
                    return null;
                }
            }

            $stylesheet = base_path('vendor/laravel/framework/resources/exceptions/renderer/dist/styles.css');

            if (is_file($stylesheet)) {
                return null;
            }

            return response()->view('errors.500', ['exception' => $e], 500);
        });
    })->create();
