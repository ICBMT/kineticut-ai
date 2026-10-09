<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('projects', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->string('name');
            $table->string('source_type')->default('upload');   // upload | path | demo
            $table->string('source_ref')->nullable();           // original filename or path
            $table->string('root_path');                        // absolute path to unpacked source
            $table->unsignedBigInteger('archive_size')->default(0);
            $table->unsignedInteger('file_count')->default(0);
            $table->unsignedBigInteger('loc')->default(0);
            $table->string('framework_version')->nullable();
            $table->string('php_constraint')->nullable();
            $table->string('composer_name')->nullable();
            $table->text('composer_description')->nullable();
            $table->unsignedInteger('package_count')->default(0);
            $table->json('meta')->nullable();
            $table->timestamp('last_scanned_at')->nullable();
            $table->timestamps();
        });

        Schema::create('scans', function (Blueprint $table) {
            $table->id();
            $table->foreignId('project_id')->constrained()->cascadeOnDelete();
            $table->string('status')->default('queued');
            $table->string('stage')->default('extract');
            $table->unsignedTinyInteger('progress')->default(0);
            $table->json('stages')->nullable();
            $table->json('metrics')->nullable();
            $table->text('error')->nullable();
            $table->unsignedInteger('file_count')->default(0);
            $table->unsignedInteger('node_count')->default(0);
            $table->unsignedInteger('edge_count')->default(0);
            $table->unsignedBigInteger('duration_ms')->default(0);
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();

            $table->index(['project_id', 'status']);
        });

        Schema::create('scan_events', function (Blueprint $table) {
            $table->id();
            $table->foreignId('scan_id')->constrained()->cascadeOnDelete();
            $table->string('level')->default('info');   // info | warn | error | success
            $table->string('stage')->nullable();
            $table->string('message');
            $table->json('context')->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index(['scan_id', 'id']);
        });

        Schema::create('graph_nodes', function (Blueprint $table) {
            $table->id();
            $table->foreignId('scan_id')->constrained()->cascadeOnDelete();
            $table->string('node_key');
            $table->string('type');
            $table->string('layer');
            $table->string('label');
            $table->string('fqcn')->nullable();
            $table->string('file_path')->nullable();
            $table->unsignedInteger('line')->nullable();
            $table->string('module')->nullable();
            $table->string('parent_key')->nullable();
            $table->unsignedSmallInteger('weight')->default(35);
            $table->unsignedSmallInteger('fan_in')->default(0);
            $table->unsignedSmallInteger('fan_out')->default(0);
            $table->unsignedSmallInteger('loc')->default(0);
            $table->float('pos_x')->default(0);
            $table->float('pos_y')->default(0);
            $table->float('pos_z')->default(0);
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->unique(['scan_id', 'node_key']);
            $table->index(['scan_id', 'type']);
            $table->index(['scan_id', 'layer']);
            $table->index(['scan_id', 'module']);
        });

        Schema::create('graph_edges', function (Blueprint $table) {
            $table->id();
            $table->foreignId('scan_id')->constrained()->cascadeOnDelete();
            $table->string('source_key');
            $table->string('target_key');
            $table->string('kind');
            $table->string('label')->nullable();
            $table->float('weight')->default(1);
            $table->unsignedSmallInteger('hits')->default(1);
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->index(['scan_id', 'source_key']);
            $table->index(['scan_id', 'target_key']);
            $table->index(['scan_id', 'kind']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('graph_edges');
        Schema::dropIfExists('graph_nodes');
        Schema::dropIfExists('scan_events');
        Schema::dropIfExists('scans');
        Schema::dropIfExists('projects');
    }
};
