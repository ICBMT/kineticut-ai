@props(['color' => 'slate'])

<span {{ $attributes->merge(['class' => "inline-flex items-center rounded-full bg-{$color}-100 px-2.5 py-1 text-xs font-medium text-{$color}-800"]) }}>
    {{ $slot }}
</span>
