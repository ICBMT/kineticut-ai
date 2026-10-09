<?php

return [
    'slack' => [
        'webhook' => env('SLACK_WEBHOOK_URL'),
        'channel' => '#taskflow-alerts',
    ],

    'stripe' => [
        'key' => env('STRIPE_KEY'),
        'secret' => env('STRIPE_SECRET'),
        'webhook_secret' => env('STRIPE_WEBHOOK_SECRET'),
    ],
];
