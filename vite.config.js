import { defineConfig } from 'vite';
import laravel from 'laravel-vite-plugin';

export default defineConfig({
    plugins: [
        laravel({
            input: ['resources/css/app.css', 'resources/js/app.js'],
            refresh: true,
        }),
    ],
    // three.js is only pulled in by the atlas page (dynamic import), so the
    // marketing pages stay small without any manual chunking.
    build: {
        chunkSizeWarningLimit: 1600,
    },
    server: {
        watch: {
            ignored: ['**/storage/**', '**/resources/demo/**'],
        },
    },
});
