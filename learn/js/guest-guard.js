(function() {
    let user = {};

    try {
        const stored = localStorage.getItem('learnUser');
        user = stored ? JSON.parse(stored) : {};
    } catch (_error) {
        user = {};
    }

    window.__guestUser = user;
    window.__isGuest = user.role === 'guest';
    window.__skipProgressTracking = window.__isGuest;

    if (!window.__isGuest) return;

    const restrictedPages = new Set([
        '/learn/checkin.html',
        '/learn/documents.html',
        '/learn/questions.html',
        '/learn/quiz.html'
    ]);

    if (restrictedPages.has(window.location.pathname)) {
        window.location.replace('/learn/index.html');
        return;
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('nav a, .nav a, .sidebar a, .nav-links a').forEach((link) => {
            const href = link.getAttribute('href') || '';
            if (href.includes('checkin') || href.includes('documents') || href.includes('questions') || href.includes('quiz')) {
                link.style.display = 'none';
            }
        });

        document.querySelectorAll('[data-progress-section], .progress-bar, .completion-badge').forEach((el) => {
            el.style.display = 'none';
        });

        const badge = document.createElement('div');
        badge.innerHTML = '👁️ Modalità consultazione';
        badge.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#fef3c7;color:#92400e;padding:8px 16px;border-radius:8px;font-size:0.85rem;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.1);';
        document.body.appendChild(badge);
    });
})();
