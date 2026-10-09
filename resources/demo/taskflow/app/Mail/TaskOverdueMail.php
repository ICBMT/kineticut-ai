<?php

namespace App\Mail;

use App\Models\Task;
use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

class TaskOverdueMail extends Mailable
{
    use Queueable, SerializesModels;

    public function __construct(public readonly Task $task) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: 'Overdue: '.$this->task->title,
            tags: ['taskflow', 'overdue'],
        );
    }

    public function content(): Content
    {
        return new Content(
            view: 'mail.task-overdue',
            with: ['task' => $this->task],
        );
    }

    public function attachments(): array
    {
        return [];
    }
}
