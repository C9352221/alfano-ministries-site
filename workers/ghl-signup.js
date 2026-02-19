/**
 * Cloudflare Worker: GHL Signup Proxy
 *
 * Securely proxies form submissions from alfanoministries.com
 * to the GoHighLevel contact creation API.
 *
 * SETUP:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Name it "ghl-signup" (will be at ghl-signup.<your-subdomain>.workers.dev)
 * 3. Paste this code into the editor
 * 4. Go to Settings → Variables → Add:
 *    - GHL_API_KEY = your GHL Private Integration Token (encrypt it)
 * 5. If using a custom domain, add a route: ghl-signup.alfanoministries.workers.dev
 *
 * ALLOWED_ORIGINS should include your site's domain.
 */

const ALLOWED_ORIGINS = [
  'https://alfanoministries.com',
  'https://www.alfanoministries.com',
  'http://localhost',       // local dev
  'http://127.0.0.1',      // local dev
];

const GHL_API_URL = 'https://services.leadconnectorhq.com/contacts/';
const GHL_LOCATION_ID = 'AIPTqymDwrSMF9zx8Pul';
const SIGNUP_TAG = 'website signup';
const EBOOK_TAG = 'ebook download';

function ghlHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json',
  };
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// Find existing contact by email or phone
async function findExistingContact(email, phone, apiKey) {
  const query = email || phone;
  const url = `${GHL_API_URL}?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url, { headers: ghlHeaders(apiKey) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.contacts?.[0] || null;
}

// Add a tag to a contact (or remove/re-add if they already have it)
async function addOrRetriggerTag(contactId, existingTags, apiKey, tag) {
  const url = `${GHL_API_URL}${contactId}`;
  const headers = ghlHeaders(apiKey);
  const hasTag = (existingTags || []).includes(tag);

  if (hasTag) {
    // Contact already has this tag — remove it first, then re-add to trigger workflow
    const tagsWithout = existingTags.filter(t => t !== tag);
    await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ tags: tagsWithout }),
    });
    await new Promise(r => setTimeout(r, 500));
  }

  // Add the tag (keep all existing tags, just append the new one)
  const currentTags = hasTag
    ? existingTags.filter(t => t !== tag)
    : (existingTags || []);
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ tags: [...currentTags, tag] }),
  });

  return res.ok;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    const safeOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(safeOrigin),
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ success: false, message: 'Method not allowed' }, 405, safeOrigin);
    }

    // Check origin
    if (!isAllowed) {
      return jsonResponse({ success: false, message: 'Forbidden' }, 403, safeOrigin);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, message: 'Invalid request body' }, 400, safeOrigin);
    }

    // Validate required fields
    const { firstName, lastName, email, phone, language, formType } = body;

    if (!email && !phone) {
      return jsonResponse({ success: false, message: 'Email or phone is required' }, 400, safeOrigin);
    }

    // Basic email validation (only if email provided)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ success: false, message: 'Invalid email address' }, 400, safeOrigin);
    }

    // Determine tag and source based on form type
    const isEbook = formType === 'ebook';
    const activeTag = isEbook ? EBOOK_TAG : SIGNUP_TAG;
    const activeSource = isEbook ? 'Faith to Build ebook' : 'Get on my list';

    // Build GHL contact payload
    const ghlPayload = {
      locationId: GHL_LOCATION_ID,
      source: activeSource,
      tags: [activeTag],
    };

    if (firstName) ghlPayload.firstName = firstName;
    if (lastName) ghlPayload.lastName = lastName;
    if (email) ghlPayload.email = email;
    if (phone) ghlPayload.phone = phone;

    // Map form values to GHL dropdown values
    const langMap = { 'english': 'English', 'spanish': 'Español', 'italian': 'Italiano' };
    ghlPayload.customFields = [
      { key: 'preferred_language', field_value: langMap[language] || 'English' }
    ];

    // Call GHL API
    try {
      const ghlRes = await fetch(GHL_API_URL, {
        method: 'POST',
        headers: ghlHeaders(env.GHL_API_KEY),
        body: JSON.stringify(ghlPayload),
      });

      if (ghlRes.ok) {
        const result = await ghlRes.json();
        console.log('Contact created:', result.contact?.id);
        return jsonResponse({
          success: true,
          message: 'Contact created successfully',
          contactId: result.contact?.id,
        }, 200, safeOrigin);
      }

      // GHL returned an error
      const errText = await ghlRes.text();
      console.error('GHL API error:', ghlRes.status, errText);

      // If it's a duplicate contact, get their ID from the error and re-trigger
      if (ghlRes.status === 400 || ghlRes.status === 422 || errText.includes('duplicate') || errText.includes('already exists')) {
        console.log('Duplicate detected, re-triggering workflow...');

        // GHL error includes the existing contact ID in meta
        let existingId = null;
        try {
          const errData = JSON.parse(errText);
          existingId = errData.meta?.contactId;
        } catch {}

        if (existingId) {
          // Fetch the existing contact to get their current tags
          const contactRes = await fetch(`${GHL_API_URL}${existingId}`, {
            headers: ghlHeaders(env.GHL_API_KEY),
          });
          if (contactRes.ok) {
            const contactData = await contactRes.json();
            const existingTags = contactData.contact?.tags || [];
            console.log('Found existing contact:', existingId, 'tags:', existingTags);
            await addOrRetriggerTag(existingId, existingTags, env.GHL_API_KEY, activeTag);
            console.log('Tag re-triggered for:', existingId);
          }
        } else {
          // Fallback: search by email then phone
          const existing = await findExistingContact(email, phone, env.GHL_API_KEY);
          if (existing) {
            console.log('Found via search:', existing.id);
            await addOrRetriggerTag(existing.id, existing.tags, env.GHL_API_KEY, activeTag);
            console.log('Tag re-triggered for:', existing.id);
          }
        }

        return jsonResponse({
          success: true,
          message: 'Welcome back! We\'ll be in touch.',
        }, 200, safeOrigin);
      }

      return jsonResponse({
        success: false,
        message: 'Something went wrong. Please try again later.',
      }, 502, safeOrigin);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({
        success: false,
        message: 'Service unavailable. Please try again later.',
      }, 503, safeOrigin);
    }
  },
};
