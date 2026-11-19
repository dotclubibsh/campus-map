// QR code print page (qr.html). Kept out of the page so its CSP can block inline scripts.
  const LIVE_URL = 'https://dotclubibsh.github.io/campus-map/';
  const baseInput = document.getElementById('base-url');
  const filterInput = document.getElementById('filter');
  const list = document.getElementById('place-list');
  const sheet = document.getElementById('sheet');
  const message = document.getElementById('message');
  const selected = new Set();
  let places = [];

  // A code printed from a local copy would not open on anyone's phone.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
  baseInput.value = isLocal ? LIVE_URL : new URL('./', location.href).href;

  function linkFor(place) {
    const url = new URL(baseInput.value);
    url.searchParams.set('from', place.id);
    return url.href;
  }

  function renderList() {
    const terms = filterInput.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    list.innerHTML = '';
    places
      .filter(p => terms.every(t => [p.display_name, p.keywords, p.cat_lvl_1].filter(Boolean).join(' ').toLowerCase().includes(t)))
      .forEach(place => {
        const row = document.createElement('label');
        row.className = 'place';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.has(place.id);
        box.onchange = () => {
          if (box.checked) selected.add(place.id); else selected.delete(place.id);
          renderSheet();
        };
        row.append(box, place.display_name);
        list.appendChild(row);
      });
  }

  function renderSheet() {
    sheet.innerHTML = '';
    message.textContent = '';
    let base;
    try {
      base = new URL(baseInput.value);
    } catch (err) {
      message.textContent = 'Enter a full link, starting with https://';
      return;
    }
    if (typeof qrcode !== 'function') {
      message.textContent = 'The QR code library did not load. Check your connection and refresh.';
      return;
    }
    places.filter(p => selected.has(p.id)).forEach(place => {
      const code = qrcode(0, 'M');
      code.addData(linkFor(place));
      code.make();

      const card = document.createElement('div');
      card.className = 'qr-card';
      const title = document.createElement('div');
      title.className = 'qr-title';
      title.textContent = 'Find your way';
      const name = document.createElement('div');
      name.className = 'qr-place';
      name.textContent = place.display_name;
      const art = document.createElement('div');
      art.innerHTML = code.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
      const sub = document.createElement('div');
      sub.className = 'qr-sub';
      sub.textContent = 'Scan for directions from here';
      card.append(title, name, art, sub);
      sheet.appendChild(card);
    });
    if (selected.size) message.textContent = `${selected.size} selected`;
  }

  filterInput.addEventListener('input', renderList);
  baseInput.addEventListener('input', renderSheet);
  document.getElementById('btn-print').onclick = () => {
    if (selected.size === 0) { message.textContent = 'Select at least one place first.'; return; }
    window.print();
  };
  document.getElementById('btn-clear').onclick = () => {
    selected.clear();
    renderList();
    renderSheet();
  };

  fetch('data/locations.json')
    .then(r => { if (!r.ok) throw new Error(`locations.json returned ${r.status}`); return r.json(); })
    .then(data => {
      places = data
        .filter(l => !l.system_data && !l.is_category_node && l.display_name)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
      renderList();
    })
    .catch(err => {
      console.error(err);
      message.textContent = 'Could not load the list of places. Refresh to try again.';
    });
