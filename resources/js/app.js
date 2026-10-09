/**
 * AtlasScope — application entry point.
 *
 * The 3D observatory pulls in three.js, which is only needed on the atlas
 * page, so it is imported lazily and the marketing pages stay light.
 */
const atlas = document.getElementById('atlas');

if (atlas) {
    import('./atlas/main.js')
        .then(({ boot }) => boot(atlas))
        .catch((error) => {
            console.error('[atlas] failed to boot', error);
            const stage = document.getElementById('stage');
            if (stage) {
                stage.insertAdjacentHTML(
                    'afterbegin',
                    `<div class="empty" style="position:absolute;inset:0;z-index:5">
                        <div><strong>3D view unavailable</strong><br>
                        <span style="font-size:.85rem">${error.message}</span></div>
                    </div>`
                );
            }
        });
}

/* ---------------------------------------------------------------- landing -- */

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('archive-input');
const uploadForm = document.getElementById('upload-form');

if (dropzone && fileInput) {
    const hint = document.getElementById('dropzone-hint');
    const errorBox = document.getElementById('upload-error');
    const limitLine = document.getElementById('dropzone-limit');
    const submitButton = document.getElementById('upload-submit');
    const progress = document.getElementById('upload-progress');
    const progressBar = document.getElementById('upload-progress-bar');
    const progressText = document.getElementById('upload-progress-text');
    const defaultHint = hint.textContent;

    const urls = {
        capacity: uploadForm?.dataset.capacityUrl,
        // The chunked endpoints share one base: /uploads/{token}[/complete].
        uploads: uploadForm?.dataset.uploadsUrl,
    };

    // Starts as what the page was rendered with, then gets replaced by a live
    // reading from the server — a php.ini limit can change under a stale tab.
    let maxBytes = Number(uploadForm?.dataset.maxBytes ?? 0);
    let capacity = null;
    let lastFile = null;
    // The guard advises; it never imprisons. One click of "Upload anyway" sends
    // the file regardless, and the server answers with a readable page if it
    // refuses.
    let forced = false;
    let uploading = false;
    let controller = null;

    const human = (bytes) => (bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
        : (bytes >= 1024 ** 2
            ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
            : `${Math.max(1, Math.round(bytes / 1024))} KB`));

    const csrf = () => uploadForm?.querySelector('input[name="_token"]')?.value ?? '';

    const showError = (message) => {
        if (!errorBox) return;

        errorBox.hidden = !message;
        errorBox.innerHTML = message ?? '';
    };

    const clearProgress = () => {
        if (progress) progress.hidden = true;
        if (progressBar) progressBar.style.width = '0%';
    };

    const setProgress = (fraction, label) => {
        if (!progress) return;

        progress.hidden = false;
        if (progressBar) progressBar.style.width = `${Math.round(fraction * 100)}%`;
        if (progressText) progressText.textContent = label;
    };

    /**
     * Which limit actually stops a plain form upload. The app ceiling is what
     * the chunked path can reach; PHP's is what a single multipart POST can.
     */
    const phpCeiling = () => Math.min(capacity?.max_bytes ?? Infinity, Number(uploadForm?.dataset.phpMaxBytes ?? Infinity));
    const appCeiling = () => capacity?.app_max_bytes ?? maxBytes;

    const applyCapacity = (data) => {
        if (!data || typeof data.max_bytes !== 'number' || data.max_bytes <= 0) return;

        capacity = data;
        maxBytes = data.app_max_bytes || data.max_bytes;

        if (limitLine && data.app_max_human) {
            // Only mention streaming when PHP is the stricter of the two limits —
            // otherwise there is nothing to work around and the sentence is noise.
            const phpIsStricter = Number(data.max_bytes) < Number(data.app_max_bytes);

            limitLine.innerHTML = phpIsStricter
                ? `Up to <b>${data.app_max_human}</b> per archive · PHP here accepts only ` +
                  `${data.max_human} in a single request (<span class="mono">upload_max_filesize&nbsp;=&nbsp;${data.upload_max_filesize}</span>), ` +
                  `so larger archives are streamed in pieces — no server changes needed.`
                : `Up to <b>${data.app_max_human}</b> per archive`;
        }

        if (lastFile) check(lastFile);
    };

    /** Ask the server what it takes right now; never block if the answer fails. */
    const refreshCapacity = () => (urls.capacity
        ? fetch(urls.capacity, { headers: { Accept: 'application/json' }, cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then(applyCapacity)
            .catch(() => {})
        : Promise.resolve());

    const raiseHint = () => (capacity?.constrained_by_php
        ? `PHP here allows ${capacity.max_human} per request. AtlasScope streams larger archives in pieces, ` +
          `so this only matters above <b>${capacity.app_max_human}</b>.`
        : `Raise <span class="mono">ATLAS_MAX_ARCHIVE_BYTES</span> if that is not intentional.`);

    const showOversize = (file) => {
        showError(
            `<strong>${file.name}</strong> is ${human(file.size)} — AtlasScope accepts up to ` +
            `<strong>${human(appCeiling())}</strong> per archive. ${raiseHint()}`
        );

        if (errorBox && !errorBox.hidden) {
            const anyway = document.createElement('button');

            anyway.type = 'button';
            anyway.className = 'btn btn--sm btn--ghost';
            anyway.id = 'upload-force';
            anyway.style.marginTop = '10px';
            anyway.textContent = 'Upload it anyway';
            anyway.addEventListener('click', () => {
                forced = true;
                uploadForm.requestSubmit ? uploadForm.requestSubmit() : uploadForm.submit();
            });

            errorBox.appendChild(anyway);
        }

        hint.textContent = `${file.name} · ${human(file.size)} — over the ${human(appCeiling())} limit`;
    };

    const check = (file) => {
        lastFile = file ?? lastFile;

        if (!file) return true;

        if (file.size > appCeiling()) {
            showOversize(file);

            return false;
        }

        showError(null);

        const streamed = file.size > phpCeiling();

        hint.textContent = streamed
            ? `${file.name} · ${human(file.size)} — streamed in pieces, click “Scan this project” to continue`
            : `${file.name} · ${human(file.size)} — click “Scan this project” to continue`;

        return true;
    };

    /**
     * Stream a big archive in ~1 MB pieces.
     *
     * Each piece is a raw request body, which PHP does not treat as a form
     * upload, so `upload_max_filesize` and `post_max_size` never come into it —
     * a stock 2 MB server takes a 150 MB archive this way.
     */
    async function streamUpload(file) {
        const name = document.getElementById('name')?.value?.trim() || null;

        setProgress(0, 'Preparing…');

        const started = await fetch(urls.uploads, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-CSRF-TOKEN': csrf(),
            },
            body: JSON.stringify({ bytes: file.size, name: file.name }),
        });

        const session = await started.json().catch(() => ({}));

        if (!started.ok) {
            throw new Error(session?.message || session?.error || 'The upload could not be started.');
        }

        const { token, chunk_size: chunkSize } = session;
        const total = Math.ceil(file.size / chunkSize);
        let sent = 0;

        try {
            for (let index = 0; index < total; index++) {
                const piece = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));

                const response = await fetch(`${urls.uploads}/${token}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        Accept: 'application/json',
                        'X-CSRF-TOKEN': csrf(),
                        'X-Atlas-Index': String(index),
                        'X-Atlas-Total': String(total),
                    },
                    body: piece,
                    signal: controller?.signal,
                });

                if (!response.ok) {
                    const detail = await response.json().catch(() => ({}));
                    throw new Error(detail?.error || `Piece ${index + 1} of ${total} was rejected.`);
                }

                sent += piece.size;

                const fraction = sent / file.size;
                setProgress(
                    fraction,
                    `Uploading ${Math.round(fraction * 100)}% · ${human(sent)} of ${human(file.size)}`,
                );
            }

            setProgress(1, 'Unpacking and scanning…');

            const finished = await fetch(`${urls.uploads}/${token}/complete`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-CSRF-TOKEN': csrf(),
                },
                body: JSON.stringify({ name }),
            });

            const result = await finished.json().catch(() => ({}));

            if (!finished.ok || !result?.redirect) {
                throw new Error(result?.message || result?.error || 'The archive could not be unpacked.');
            }

            window.location.href = result.redirect;
        } catch (error) {
            // Abort the session so the pieces do not linger on disk.
            fetch(`${urls.uploads}/${token}`, {
                method: 'DELETE',
                headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrf() },
            }).catch(() => {});

            throw error;
        }
    }

    async function submitUpload(file) {
        uploading = true;
        submitButton.disabled = true;
        submitButton.textContent = 'Uploading…';
        showError(null);

        try {
            await streamUpload(file);
        } catch (error) {
            clearProgress();
            showError(`<strong>Upload failed.</strong> ${error.message}`);
            hint.textContent = defaultHint;
        } finally {
            uploading = false;
            submitButton.disabled = false;
            submitButton.textContent = 'Scan this project';
        }
    }

    dropzone.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropzone.classList.add('is-over');
    });

    ['dragleave', 'drop'].forEach((type) =>
        dropzone.addEventListener(type, () => dropzone.classList.remove('is-over'))
    );

    dropzone.addEventListener('drop', (event) => {
        const file = event.dataTransfer?.files?.[0];

        if (file) {
            fileInput.files = event.dataTransfer.files;
            check(file);
            refreshCapacity();
        }
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];

        if (!file) {
            lastFile = null;
            showError(null);
            clearProgress();
            hint.textContent = defaultHint;

            return;
        }

        check(file);
        refreshCapacity();
    });

    // A limit raised in another shell should reach a tab that has been open all
    // along, so re-ask whenever the page regains attention.
    window.addEventListener('focus', refreshCapacity);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshCapacity();
    });

    refreshCapacity();

    uploadForm?.addEventListener('submit', (event) => {
        if (uploading) {
            event.preventDefault();

            return;
        }

        const file = fileInput.files?.[0];

        if (!forced && !check(file)) {
            event.preventDefault();

            return;
        }

        forced = false;

        // Small enough for one multipart POST? Let the form do its thing.
        if (file && file.size <= phpCeiling()) {
            submitButton.disabled = true;
            submitButton.textContent = 'Uploading & unpacking…';

            return;
        }

        // Otherwise stream it in pieces, which sidesteps PHP's limits entirely.
        event.preventDefault();
        controller = new AbortController();
        submitUpload(file);
    });
}
