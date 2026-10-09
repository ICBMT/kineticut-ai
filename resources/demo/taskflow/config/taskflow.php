<?php

return [
    // Days before a task is considered overdue.
    'overdue_grace_days' => env('TASKFLOW_GRACE_DAYS', 2),

    // How many reminders we send for a single task.
    'max_reminders' => env('TASKFLOW_MAX_REMINDERS', 3),

    'reports' => [
        'disk' => env('TASKFLOW_REPORT_DISK', 'local'),
        'keep_days' => 30,
    ],

    'integrations' => [
        'slack' => env('SLACK_WEBHOOK_URL'),
        'stripe' => [
            'key' => env('STRIPE_KEY'),
            'secret' => env('STRIPE_SECRET'),
        ],
    ],
];
