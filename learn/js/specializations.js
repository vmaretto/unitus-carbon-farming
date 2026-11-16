(() => {
    const root = document.getElementById('specializations-list');
    const token = localStorage.getItem('learnToken');
    if (!token) { location.replace('/learn/login.html'); return; }
    const el = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    async function request(url, options = {}) {
        const response = await fetch(url, { ...options, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
        if (response.status === 401) { location.replace('/learn/login.html'); throw new Error('Sessione scaduta.'); }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Operazione non riuscita. Riprova.');
        return data;
    }
    function render(edition) {
        const card = el('article', undefined, 'card');
        card.append(el('h2', edition.courseTitle), el('p', edition.editionName, 'muted'));
        const current = el('p', edition.selectedOptionId ? 'Scelta confermata: ' + edition.selectedTitle : 'Non hai ancora scelto un modulo.', 'selection-status');
        current.setAttribute('role', 'status');
        card.append(current);
        const editable = edition.isOpen && (!edition.selectedOptionId || edition.allowChanges);
        card.append(el('p', !edition.isOpen ? 'Le scelte per questa edizione sono chiuse.' :
            !editable ? 'La scelta è definitiva. Per modifiche contatta la segreteria.' :
            edition.allowChanges ? 'Scegli un modulo. Potrai cambiare la scelta finché le iscrizioni resteranno aperte.' :
            'Scegli un modulo. Dopo la conferma non potrai modificare la scelta.', 'muted'));
        if (!edition.options.length) { card.append(el('p', 'Non ci sono moduli disponibili al momento.')); return card; }
        const form = el('form');
        const fieldset = el('fieldset');
        fieldset.append(el('legend', 'Moduli specialistici disponibili'));
        fieldset.disabled = !editable;
        for (const option of edition.options) {
            const label = el('label', undefined, 'module-option');
            const radio = el('input');
            radio.type = 'radio'; radio.name = 'optionId'; radio.value = option.id;
            radio.required = true; radio.checked = edition.selectedOptionId === option.id;
            const copy = el('span');
            copy.append(el('strong', option.title), el('span', option.description, 'description'));
            label.append(radio, copy); fieldset.append(label);
        }
        const button = el('button', edition.selectedOptionId ? 'Aggiorna scelta' : 'Conferma scelta');
        button.type = 'submit'; button.disabled = !editable;
        const status = el('p', '', 'form-status'); status.setAttribute('role', 'status');
        form.append(fieldset, button, status);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const optionId = new FormData(form).get('optionId');
            if (!optionId) return;
            button.disabled = true; fieldset.disabled = true;
            status.textContent = 'Salvataggio in corso…';
            try {
                await request(`/api/lms/specializations/${edition.editionId}/choice`, { method: 'PUT', body: JSON.stringify({ optionId }) });
                edition.selectedOptionId = optionId;
                edition.selectedTitle = edition.options.find(option => option.id === optionId).title;
                const updated = render(edition);
                card.replaceWith(updated);
                updated.querySelector('.selection-status').setAttribute('tabindex', '-1');
                updated.querySelector('.selection-status').focus();
            } catch (error) {
                status.textContent = error.message;
                button.disabled = false; fieldset.disabled = false;
            }
        });
        card.append(form);
        return card;
    }
    async function load() {
        root.textContent = 'Caricamento…';
        try {
            const editions = await request('/api/lms/specializations');
            root.replaceChildren(...editions.map(render));
            if (!editions.length) root.append(el('p', 'Non risultano iscrizioni attive. Contatta la segreteria se ritieni che ci sia un errore.', 'card'));
        } catch (error) {
            root.replaceChildren(el('p', error.message));
            const retry = el('button', 'Riprova'); retry.addEventListener('click', load); root.append(retry);
        }
    }
    document.getElementById('logout-btn').addEventListener('click', event => {
        event.preventDefault(); localStorage.removeItem('learnToken'); localStorage.removeItem('learnUser'); location.href = '/learn/login.html';
    });
    load();
})();
