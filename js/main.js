/* ============================================
   Alfano Ministries — Main JS
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

    // ── Mobile Menu Toggle ──
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');

    if (hamburger && navLinks) {
        function openMenu() {
            hamburger.classList.add('open');
            navLinks.classList.add('open');
            hamburger.setAttribute('aria-expanded', 'true');
            const firstLink = navLinks.querySelector('a');
            if (firstLink) firstLink.focus();
        }

        function closeMenu() {
            hamburger.classList.remove('open');
            navLinks.classList.remove('open');
            hamburger.setAttribute('aria-expanded', 'false');
            hamburger.focus();
        }

        hamburger.setAttribute('aria-expanded', 'false');

        hamburger.addEventListener('click', () => {
            if (navLinks.classList.contains('open')) {
                closeMenu();
            } else {
                openMenu();
            }
        });

        // Close menu when a link is clicked
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                closeMenu();
            });
        });

        // ESC key closes menu
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && navLinks.classList.contains('open')) {
                closeMenu();
            }
        });
    }

    // ── Navbar scroll effect ──
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        window.addEventListener('scroll', () => {
            if (window.scrollY > 50) {
                navbar.classList.add('scrolled');
            } else {
                navbar.classList.remove('scrolled');
            }
        });
    }

    // ── Map touch overlay (mobile scroll fix) ──
    const mapOverlay = document.querySelector('.map-touch-overlay');
    if (mapOverlay) {
        let overlayTimer;
        mapOverlay.addEventListener('click', () => {
            mapOverlay.classList.add('active');
            clearTimeout(overlayTimer);
            overlayTimer = setTimeout(() => {
                mapOverlay.classList.remove('active');
            }, 5000);
        });
    }

    // ── Scroll fade-in animations ──
    const fadeEls = document.querySelectorAll('.fade-in');
    if (fadeEls.length > 0) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.1,
            rootMargin: '0px 0px -40px 0px'
        });

        fadeEls.forEach(el => observer.observe(el));
    }

    // ── Active nav link highlight ──
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
            link.classList.add('active');
        }
    });

    // ── Podcast RSS Loader ──
    const RSS_FEED = 'https://anchor.fm/s/f4cac4f8/podcast/rss';
    const RSS_API = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(RSS_FEED);
    const PODCAST_ART = 'https://d3t3ozftmdmh3i.cloudfront.net/production/podcast_uploaded_nologo/40969294/40969294-1713838427761-d93b6e3c8f43.jpg';

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || '';
    }

    function buildEpisodeCard(ep, index) {
        const img = ep.thumbnail || PODCAST_ART;
        const desc = stripHtml(ep.description).substring(0, 180) + '...';
        const date = formatDate(ep.pubDate);
        const epNum = ep.itunes_episode || (index !== undefined ? '' : '');

        return `
            <div class="episode-card">
                <img class="episode-card-img" src="${img}" alt="${ep.title}" loading="lazy" onerror="this.src='${PODCAST_ART}'">
                <div class="episode-card-body">
                    <div class="episode-meta">
                        ${epNum ? `<span class="episode-number">EP ${epNum}</span><span class="episode-dot"></span>` : ''}
                        <span>${date}</span>
                    </div>
                    <h3>${ep.title}</h3>
                    <p class="episode-desc">${desc}</p>
                    <audio class="episode-player" controls preload="none" src="${ep.enclosure.link}"></audio>
                    <a class="episode-link" href="${ep.link}" target="_blank" rel="noopener">Listen on Spotify &rarr;</a>
                </div>
            </div>
        `;
    }

    function loadPodcastEpisodes() {
        const containers = document.querySelectorAll('[data-podcast-feed]');
        if (containers.length === 0) return;

        containers.forEach(container => {
            const count = parseInt(container.getAttribute('data-episode-count') || '6', 10);
            container.innerHTML = '<div class="episode-loading"><div class="spinner"></div><p>Loading episodes...</p></div>';

            fetch(RSS_API)
                .then(res => res.json())
                .then(data => {
                    if (data.status !== 'ok' || !data.items || data.items.length === 0) {
                        throw new Error('No episodes found');
                    }
                    const episodes = data.items.slice(0, count);
                    const cards = episodes.map((ep, i) => buildEpisodeCard(ep, i)).join('');
                    container.innerHTML = `<div class="episode-grid">${cards}</div>`;
                })
                .catch(() => {
                    // Fallback: show Spotify embed player
                    container.innerHTML = `
                        <div style="max-width: 800px; margin: 0 auto;">
                            <iframe class="spotify-embed" src="https://open.spotify.com/embed/show/6OuaAK03zmDwKwQCxG47mx?theme=0" allowfullscreen loading="lazy" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>
                        </div>
                    `;
                });
        });
    }

    loadPodcastEpisodes();

    // ── GHL Signup Form ──
    const SIGNUP_WORKER_URL = 'https://ghl-signup.alfanoministries.workers.dev';

    const signupForm = document.getElementById('ghl-signup-form');
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = document.getElementById('signup-submit');
            const messageEl = document.getElementById('signup-message');
            const email = document.getElementById('signup-email').value.trim();
            const phone = document.getElementById('signup-phone').value.trim();
            const consent = document.getElementById('signup-consent').checked;

            // Clear previous messages
            messageEl.textContent = '';
            messageEl.className = 'signup-message';

            // Validate required fields
            if (!email || !phone) {
                messageEl.textContent = 'Please fill in your email and phone number.';
                messageEl.className = 'signup-message error';
                return;
            }

            if (!consent) {
                messageEl.textContent = 'Please agree to receive messages before signing up.';
                messageEl.className = 'signup-message error';
                return;
            }

            // Loading state
            submitBtn.classList.add('loading');
            submitBtn.textContent = 'Signing up...';

            const payload = {
                firstName: document.getElementById('signup-first-name').value.trim(),
                lastName: document.getElementById('signup-last-name').value.trim(),
                email: email,
                phone: phone,
                language: document.getElementById('signup-language').value
            };

            try {
                const res = await fetch(SIGNUP_WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    messageEl.textContent = 'You\'re signed up! We\'ll be in touch soon.';
                    messageEl.className = 'signup-message success';
                    signupForm.reset();
                } else {
                    messageEl.textContent = data.message || 'Something went wrong. Please try again.';
                    messageEl.className = 'signup-message error';
                }
            } catch (err) {
                messageEl.textContent = 'Could not connect. Please try again later.';
                messageEl.className = 'signup-message error';
            }

            submitBtn.classList.remove('loading');
            submitBtn.textContent = 'Sign Up';
        });
    }

    // ── Ebook Download Form ──
    const ebookForm = document.getElementById('ebook-form');
    if (ebookForm) {
        ebookForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = document.getElementById('ebook-submit');
            const messageEl = document.getElementById('ebook-message');
            const downloadSection = document.getElementById('download-section');
            const firstName = document.getElementById('ebook-first-name').value.trim();
            const email = document.getElementById('ebook-email').value.trim();

            // Clear previous messages
            messageEl.textContent = '';
            messageEl.className = '';
            downloadSection.classList.remove('visible');

            if (!email) {
                messageEl.textContent = 'Please enter your email address.';
                messageEl.className = 'error';
                return;
            }

            // Loading state
            submitBtn.classList.add('loading');
            submitBtn.textContent = 'Sending...';

            const payload = {
                firstName: firstName,
                email: email,
                formType: 'ebook'
            };

            try {
                const res = await fetch(SIGNUP_WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    ebookForm.style.display = 'none';
                    downloadSection.classList.add('visible');
                } else {
                    messageEl.textContent = data.message || 'Something went wrong. Please try again.';
                    messageEl.className = 'error';
                }
            } catch (err) {
                messageEl.textContent = 'Could not connect. Please try again later.';
                messageEl.className = 'error';
            }

            submitBtn.classList.remove('loading');
            submitBtn.textContent = 'Send Me the Book';
        });
    }

    // ── Claim Ebook Form (Give Page) ──
    const claimForm = document.getElementById('claim-ebook-form');
    if (claimForm) {
        const claimCheckbox = document.getElementById('claim-confirm');
        const claimSubmitBtn = document.getElementById('claim-submit');

        // Enable/disable submit based on checkbox
        claimCheckbox.addEventListener('change', () => {
            claimSubmitBtn.disabled = !claimCheckbox.checked;
        });

        claimForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const messageEl = document.getElementById('claim-message');
            const successEl = document.getElementById('claim-success');
            const firstName = document.getElementById('claim-first-name').value.trim();
            const lastName = document.getElementById('claim-last-name').value.trim();
            const email = document.getElementById('claim-email').value.trim();
            const phone = document.getElementById('claim-phone').value.trim();
            const language = document.getElementById('claim-language').value;

            messageEl.textContent = '';
            messageEl.className = 'signup-message';

            if (!firstName || !lastName || !email || !phone) {
                messageEl.textContent = 'Please fill in all fields.';
                messageEl.className = 'signup-message error';
                return;
            }

            if (!claimCheckbox.checked) {
                messageEl.textContent = 'Please confirm that you have made a donation.';
                messageEl.className = 'signup-message error';
                return;
            }

            claimSubmitBtn.classList.add('loading');
            claimSubmitBtn.textContent = 'Sending...';

            const payload = {
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: phone,
                language: language,
                formType: 'ebook'
            };

            try {
                const res = await fetch(SIGNUP_WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    claimForm.style.display = 'none';
                    successEl.style.display = 'block';
                } else {
                    messageEl.textContent = data.message || 'Something went wrong. Please try again.';
                    messageEl.className = 'signup-message error';
                }
            } catch (err) {
                messageEl.textContent = 'Could not connect. Please try again later.';
                messageEl.className = 'signup-message error';
            }

            claimSubmitBtn.classList.remove('loading');
            claimSubmitBtn.textContent = 'Send Me the Book';
        });
    }

    // ── Tour Inquiry Form ──
    const tourForm = document.getElementById('tour-inquiry-form');
    if (tourForm) {
        tourForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const submitBtn = document.getElementById('tour-submit');
            const messageEl = document.getElementById('tour-message-status');
            const firstName = document.getElementById('tour-first-name').value.trim();
            const lastName = document.getElementById('tour-last-name').value.trim();
            const email = document.getElementById('tour-email').value.trim();
            const phone = document.getElementById('tour-phone').value.trim();
            const groupSize = document.getElementById('tour-group-size').value;
            const tourOption = document.getElementById('tour-option').value;
            const message = document.getElementById('tour-message').value.trim();

            messageEl.textContent = '';
            messageEl.className = 'signup-message';

            if (!firstName || !lastName || !email || !phone) {
                messageEl.textContent = 'Please fill in all required fields.';
                messageEl.className = 'signup-message error';
                return;
            }

            submitBtn.classList.add('loading');
            submitBtn.textContent = 'Sending...';

            const payload = {
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: phone,
                groupSize: groupSize,
                tourOption: tourOption,
                message: message,
                formType: 'tour-inquiry'
            };

            try {
                const res = await fetch(SIGNUP_WORKER_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    messageEl.textContent = 'Thank you! We\'ll be in touch with tour details soon.';
                    messageEl.className = 'signup-message success';
                    tourForm.reset();
                } else {
                    messageEl.textContent = data.message || 'Something went wrong. Please try again.';
                    messageEl.className = 'signup-message error';
                }
            } catch (err) {
                messageEl.textContent = 'Could not connect. Please try again later.';
                messageEl.className = 'signup-message error';
            }

            submitBtn.classList.remove('loading');
            submitBtn.textContent = 'Send Inquiry';
        });
    }

    // ── Itinerary Toggle (smooth scroll) ──
    document.querySelectorAll('.itinerary-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.querySelector(btn.getAttribute('href'));
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    // ── Mailing List Popup ──
    const POPUP_KEY = 'am_popup_dismissed';
    const POPUP_DAYS = 7; // show again after 7 days

    function shouldShowPopup() {
        const dismissed = localStorage.getItem(POPUP_KEY);
        if (!dismissed) return true;
        const daysSince = (Date.now() - parseInt(dismissed, 10)) / (1000 * 60 * 60 * 24);
        return daysSince >= POPUP_DAYS;
    }

    function dismissPopup() {
        localStorage.setItem(POPUP_KEY, Date.now().toString());
        const overlay = document.querySelector('.popup-overlay');
        if (overlay) overlay.classList.remove('active');
    }

    // Don't show popup on the give page or book page (they're already there)
    const isGivePage = window.location.pathname.includes('give');
    const isBookPage = window.location.pathname.includes('book');

    if (shouldShowPopup() && !isGivePage && !isBookPage) {
        const overlay = document.createElement('div');
        overlay.className = 'popup-overlay';
        overlay.innerHTML = `
            <div class="popup-box">
                <button class="popup-close" aria-label="Close">&times;</button>
                <div class="popup-eyebrow">Free Gift with Any Donation</div>
                <h2>Faith to Build</h2>
                <div class="popup-divider"></div>
                <p>Donate any amount and receive a free copy of <strong>Faith to Build: A Kingdom Business Blueprint</strong> by Marc Alfano.</p>
                <a href="give.html" class="popup-cta-btn">Give &amp; Get the Book</a>
                <button class="popup-no-thanks">No thanks</button>
            </div>
        `;
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.classList.add('active');
        }, 3000);

        overlay.querySelector('.popup-close').addEventListener('click', dismissPopup);
        overlay.querySelector('.popup-no-thanks').addEventListener('click', dismissPopup);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) dismissPopup();
        });

        overlay.querySelector('.popup-cta-btn').addEventListener('click', () => {
            dismissPopup();
        });
    }

});

// ── Copy-to-clipboard with feedback ──
function copyToClipboard(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
    }).catch(() => {
        const original = btn.textContent;
        btn.textContent = 'Copy failed — try manually';
        setTimeout(() => { btn.textContent = original; }, 3000);
    });
}
