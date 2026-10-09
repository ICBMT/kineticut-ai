<?php

namespace App\Notifications;

use App\Services\ReportService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Notifications\Notification;

class WeeklyDigestNotification extends Notification implements ShouldQueue
{
    use Queueable;

    public function __construct(private readonly array $summary) {}

    public static function forUser(object $user, ReportService $reports): self
    {
        return new self($reports->weeklySummary($user));
    }

    public function via(object $notifiable): array
    {
        return ['mail'];
    }

    public function toMail(object $notifiable): MailMessage
    {
        return (new MailMessage)
            ->subject('Your week in TaskFlow')
            ->line("Open tasks: {$this->summary['open']}")
            ->line("Overdue: {$this->summary['overdue']}")
            ->line("Completed: {$this->summary['completed_this_week']}");
    }
}
