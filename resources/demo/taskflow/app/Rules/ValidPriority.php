<?php

namespace App\Rules;

use App\Enums\TaskPriority;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

class ValidPriority implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (TaskPriority::tryFrom((string) $value) === null) {
            $fail('The :attribute must be one of low, medium, high or urgent.');
        }
    }
}
