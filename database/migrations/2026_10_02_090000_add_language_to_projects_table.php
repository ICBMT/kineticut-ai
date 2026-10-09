<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Which language a project is written in. It decides the stage plan, the file
 * extensions the indexer counts and the badge on the project card. Existing
 * rows predate the column, so they default to PHP — which is what they are.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('projects', function (Blueprint $table) {
            $table->string('language', 16)->default('php')->after('name');
        });
    }

    public function down(): void
    {
        Schema::table('projects', function (Blueprint $table) {
            $table->dropColumn('language');
        });
    }
};
