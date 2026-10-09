<?php

namespace App\Notifications;

use App\Models\Task;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Notifications\Notification;

class TaskAssignedNotification extends Notification implements ShouldQueue
{
    use Queueable;

    public function __construct(public readonly Task $task) {}

    public function via(object $notifiable): array
    {
        return ['mail', 'database'];
    }

    public function toMail(object $notifiable): MailMessage
    {
        return (new MailMessage)
            ->subject('You have been assigned: '.$this->task->title)
            ->line('Due '.$this->task->due_at?->diffForHumans())
            ->action('Open task', route('tasks.show', $this->task));
    }

    public function toArray(object $notifiable): array
    {
        return ['task_id' => $this->task->id, 'title' => $this->task->title];
    }
}
