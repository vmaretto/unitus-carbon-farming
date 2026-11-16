(() => {
    const editionSelect = document.getElementById('specialist-edition');
    const panel = document.getElementById('specialist-panel');
    const message = document.getElementById('specialist-message');
    const settingsForm = document.getElementById('specialist-settings');
    const optionForm = document.getElementById('specialist-option-form');
    let data = null;
    let requestSequence = 0;
    let busy = false;
    const el = (tag, text) => {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    };
    function resetOption() {
        optionForm.reset();
        document.getElementById('specialist-option-id').value = '';
        document.getElementById('specialist-option-cancel').hidden = true;
        document.getElementById('specialist-option-save').textContent = 'Aggiungi modulo';
    }
    window.loadSpecializationsSection = async function () {
        try {
            const [courses, editions] = await Promise.all([apiRequest('/api/lms/courses'), apiRequest('/api/lms/course-editions')]);
            const current = editionSelect.value;
            editionSelect.replaceChildren(new Option('Seleziona un’edizione', ''));
            editions.forEach(edition => editionSelect.add(new Option(
                `${courses.find(course => course.id === edition.courseId)?.title || 'Corso'} — ${edition.editionName}${edition.isActive ? '' : ' (inattiva)'}`, edition.id)));
            editionSelect.value = current;
            if (editionSelect.value) await loadEdition();
        } catch (error) { message.textContent = error.message; }
    };
    async function loadEdition() {
        const sequence = ++requestSequence;
        panel.hidden = true; data = null; resetOption();
        if (!editionSelect.value) { message.textContent = ''; return; }
        message.textContent = 'Caricamento…';
        try {
            const result = await apiRequest(`/api/admin/specializations/${editionSelect.value}`);
            if (sequence !== requestSequence) return;
            data = result;
            document.getElementById('specialist-open').checked = data.isOpen;
            document.getElementById('specialist-changes').checked = data.allowChanges;
            render(); panel.hidden = false; message.textContent = '';
        } catch (error) { if (sequence === requestSequence) message.textContent = error.message; }
    }
    function render() {
        const options = document.getElementById('specialist-options');
        options.replaceChildren();
        data.options.forEach(option => {
            const row = el('tr');
            const count = data.students.filter(student => student.selectedOptionId === option.id && student.enrollmentStatus === 'active').length;
            [option.title, option.isActive ? 'Disponibile' : 'Disattivato', option.sortOrder, count].forEach(value => row.append(el('td', value)));
            const actions = el('td'); const edit = el('button', 'Modifica'); edit.type = 'button'; edit.className = 'secondary';
            edit.addEventListener('click', () => {
                document.getElementById('specialist-option-id').value = option.id;
                document.getElementById('specialist-title').value = option.title;
                document.getElementById('specialist-description').value = option.description;
                document.getElementById('specialist-active').checked = option.isActive;
                document.getElementById('specialist-order').value = option.sortOrder;
                document.getElementById('specialist-option-cancel').hidden = false;
                document.getElementById('specialist-option-save').textContent = 'Salva modifiche';
                document.getElementById('specialist-title').focus();
            });
            actions.append(edit); row.append(actions); options.append(row);
        });
        if (!data.options.length) { const row = el('tr'); const cell = el('td', 'Nessun modulo configurato. Aggiungi il primo modulo.'); cell.colSpan = 5; row.append(cell); options.append(row); }
        const students = document.getElementById('specialist-students'); students.replaceChildren();
        data.students.forEach(student => {
            const row = el('tr');
            const labels = { active: 'Attiva', suspended: 'Sospesa', completed: 'Completata', cancelled: 'Annullata' };
            [`${student.firstName} ${student.lastName}`, student.email, labels[student.enrollmentStatus] || student.enrollmentStatus,
                student.selectedTitle || 'Non ha ancora scelto', student.selectedAt ? new Date(student.selectedAt).toLocaleString('it-IT') : '—']
                .forEach(value => row.append(el('td', value)));
            students.append(row);
        });
        const active = data.students.filter(student => student.enrollmentStatus === 'active');
        document.getElementById('specialist-summary').textContent = `${active.filter(student => student.selectedOptionId).length} scelte confermate su ${active.length} studenti con iscrizione attiva.`;
    }
    async function save(path, method, body) {
        if (busy) return;
        busy = true;
        const controls = [...panel.querySelectorAll('button, input, textarea')];
        controls.forEach(control => { control.disabled = true; }); editionSelect.disabled = true;
        message.textContent = 'Salvataggio…';
        try {
            await apiRequest(`/api/admin/specializations/${editionSelect.value}/${path}`, { method, body: JSON.stringify(body), _maxAttempts: 1 });
            await loadEdition();
            if (data) message.textContent = 'Salvato.';
        } catch (error) { message.textContent = error.message; }
        finally { controls.forEach(control => { control.disabled = false; }); editionSelect.disabled = false; busy = false; }
    }
    settingsForm.addEventListener('submit', event => {
        event.preventDefault();
        save('settings', 'PUT', { isOpen: document.getElementById('specialist-open').checked, allowChanges: document.getElementById('specialist-changes').checked });
    });
    optionForm.addEventListener('submit', event => {
        event.preventDefault();
        const id = document.getElementById('specialist-option-id').value;
        save('options' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', {
            title: document.getElementById('specialist-title').value,
            description: document.getElementById('specialist-description').value,
            isActive: document.getElementById('specialist-active').checked,
            sortOrder: Number(document.getElementById('specialist-order').value)
        });
    });
    editionSelect.addEventListener('change', loadEdition);
    document.getElementById('specialist-option-cancel').addEventListener('click', resetOption);
    document.getElementById('specialist-refresh').addEventListener('click', loadEdition);
})();
