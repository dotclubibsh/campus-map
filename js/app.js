// Campus Connect, the IFHE Hyderabad campus map. Loaded by index.html as a module; moved out of the page
// so the Content Security Policy does not need to allow inline scripts.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  buildGraph, buildSteps, createGeoTransform, currentStepIndex, findRoute, floorInstruction, formatDistance,
  polylineLength, progressAlong, snapToGraph, walkingMinutes,
} from './navigation.js?v=5'; // Raise v whenever navigation.js changes, so browsers don't reuse an old copy

// --- STATE ---
let glbFile, jsonFile, mapData;
let scene, renderer, camera2D, camera3D, activeCamera, controls2D, controls3D;
let worldGroup = new THREE.Group(); 
let pubgLabelsGroup = new THREE.Group();
let searchPinGroup = new THREE.Group();
let modelBounds = null;
let groundY = 0;

let buildingMeshesMap = new Map(); 
let originalMaterials = new Map();
let activeHighlightMeshes = [];
let aodSpritesMap = new Map();

let navGroup = new THREE.Group();
let geo = null, walkData = null, walkGraph = null;
let selectedLocation = null, navState = null;
let qrStartLocation = null, avoidStairs = false, walkLandmarks = [];
let headingArrow = null, compassHeading = null, compassListener = null;

const FLY_ZOOM_2D = 8;
const FLY_DIST_3D = 120;

const BACKGROUND_COLOR = '#121318';
let sunLight = null;
let worldBox = null;          // The campus model's extent, after it is rotated to face north
let shadowsDirty = true;      // Set when buildings appear, hide or move, so shadows are redrawn

const defaultBuildingMat = new THREE.MeshPhysicalMaterial({ 
  color: 0x8892b0,        
  transparent: true, 
  opacity: 0.85,          
  depthWrite: true,       
  side: THREE.DoubleSide,
  roughness: 0.15,        
  metalness: 0.4,         
  clearcoat: 1.0,         
  clearcoatRoughness: 0.1 
});

// Location names come from data/locations.json; escape them before building HTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// --- HELPER FOR AUTO-SCROLLING TEXT ---
function applyAutoScroll(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  
  el.classList.remove('scrolling-text');
  el.style.transform = 'translateX(0)';
  
  requestAnimationFrame(() => {
    const parentWidth = el.parentElement.clientWidth;
    const textWidth = el.scrollWidth;
    
    if (textWidth > parentWidth) {
      const dist = textWidth - parentWidth + 12; 
      el.style.setProperty('--scroll-dist', `-${dist}px`);
      el.classList.add('scrolling-text');
    }
  });
}

// --- OLD SETUP UI LOGIC REMOVED ---
// Files now load automatically from assets/ and data/ folders

// Auto-load files on page load - no upload screen needed
onDocumentReady(() => {
  // Show loading screen
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) loadingScreen.style.display = 'flex';

  if (!hasWebGL()) {
    showFatalError('This browser can\'t show the 3D map',
      'Try the latest Chrome, Safari, Edge or Firefox, or turn on hardware acceleration in your browser settings.');
    return;
  }

  initThree();
  
  // Setup Draco compression decoder
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  dracoLoader.setDecoderConfig({ type: 'js' });
  
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  
  // Load GLB from server (not from file upload)
  loader.load('assets/model.glb', (gltf) => {
    worldGroup.add(gltf.scene);
    worldGroup.add(pubgLabelsGroup);
    worldGroup.add(searchPinGroup);
    worldGroup.add(navGroup);

    let ys = [];
    gltf.scene.traverse(obj => {
      if (!obj.isMesh) return;
      originalMaterials.set(obj.uuid, obj.material);
      let nameSource = obj;
      while (nameSource && (!nameSource.name || nameSource.name === '')) nameSource = nameSource.parent;
      const name = nameSource ? nameSource.name : obj.name;
      
      if (/^Plane(\.\d+)?$/.test(name)) {
        ys.push(new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3()).y);
        obj.receiveShadow = true;
      } else {
        buildingMeshesMap.set(name, obj);
      }
    });
    
    modelBounds = new THREE.Box3().setFromObject(worldGroup);
    groundY = ys.length > 0 ? ys.sort()[Math.floor(ys.length / 2)] : modelBounds.min.y;

    // Load JSON from server
    fetch('data/locations.json')
      .then(r => r.json())
      .then(data => {
        mapData = data;
        
        const calibData = mapData.find(l => l.id === "calibration_data");
        if (calibData && calibData.calibration && calibData.calibration.appliedRotationY !== undefined) {
          worldGroup.rotation.y = calibData.calibration.appliedRotationY;
        }

        prepareBuildings();
        applyDefaultAesthetic();
        setupCameras(groundY);
        setupSunAndFog();
        loadCampusShell();
        generatePUBGLabels(); 
        
        // Hide setup overlay and show app
        document.getElementById('setup-overlay').style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        setMode('2d');
        animate();
        initNavigation(calibData);
        onAppReady();
      })
      .catch(err => {
        console.error('Error loading JSON:', err);
        showFatalError('Couldn\'t load the list of places', navigator.onLine
          ? 'Something went wrong on our side. Please try again in a moment.'
          : 'You seem to be offline. Connect to the internet and try again.');
      });
      
  }, (event) => {
    // The model is about 2.3 MB, so show real progress on slow connections.
    if (event.lengthComputable) setLoadProgress(0.1 + 0.8 * (event.loaded / event.total), 'Loading the campus…');
  }, (error) => {
    console.error('Error loading GLB:', error);
    showFatalError('The 3D map couldn\'t load', navigator.onLine
      ? 'Please check your connection and try again.'
      : 'You seem to be offline. The map needs internet the first time you open it.');
  });
});

// --- SEARCH & UI LOGIC ---
const defaultCategories = [
  { 
    id: 'cat_food',
    name: 'Food', 
    icon: '<svg viewBox="0 0 24 24"><path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.86 3.75 3.97V22h2.5v-9.03C11.34 12.86 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/></svg>' 
  },
  { 
    id: 'cat_hostels',
    name: 'Hostels', 
    icon: '<svg viewBox="0 0 24 24"><path d="M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z"/></svg>' 
  },
  { 
    id: 'cat_academics',
    name: 'Academics', 
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3L1 9l11 6 9-4.91V17h2V9M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>' 
  },
  { 
    id: 'cat_sports',
    name: 'Sports', 
    icon: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/></svg>' 
  },
  { 
    id: 'cat_utility',
    name: 'Utility', 
    icon: '<svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>' 
  }
];
const defaultSuggestions = ['LT - A', 'Swimming Pool', 'Bru Cafe', 'Seminar Hall', 'Library'];

const searchInput = document.getElementById('search-input');
const suggBox = document.getElementById('suggestions');
const btnClear = document.getElementById('btn-clear-search');
const btnCloseSheet = document.getElementById('btn-close-sheet');
const fabBottom = document.querySelector('.fab-bottom');
const btnShowCats = document.getElementById('btn-show-categories');
const bottomSheet = document.getElementById('bottom-sheet');
const btnCollapse = document.getElementById('btn-collapse-sheet');
const iconCollapse = document.getElementById('icon-collapse');
const joyZone = document.getElementById('joystick-zone');
const joyKnob = document.getElementById('joystick-knob');

// 1. --- THE SUB-LIST RENDERER (Used by both Classrooms and Faculty) ---
function renderCategoryLocations(categoryName, locationIds, onBackCallback = null) {
  searchInput.value = categoryName;
  btnClear.style.display = 'flex';
  suggBox.innerHTML = '';

  const backBtn = document.createElement('div');
  backBtn.className = 'category-item';
  backBtn.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
  backBtn.style.position = 'sticky';
  backBtn.style.top = '0';
  backBtn.style.background = 'var(--glass-bg)';
  backBtn.style.backdropFilter = 'blur(12px)';
  backBtn.style.zIndex = '10';
  backBtn.innerHTML = `
    <div class="category-icon" style="background: transparent;">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </div>
    <span class="category-name">Back</span>
  `;
  
  backBtn.onclick = (e) => {
    e.stopPropagation();
    if (onBackCallback) {
        onBackCallback(); 
    } else {
        searchInput.value = '';
        btnClear.style.display = 'none';
        renderCategories(); 
    }
  };
  suggBox.appendChild(backBtn);

  let locations = locationIds.map(id => mapData.find(l => l.id === id)).filter(Boolean);
  locations.sort((a, b) => a.display_name.localeCompare(b.display_name));

  if (locations.length === 0) {
     const emptyMsg = document.createElement('div');
     emptyMsg.className = 'result-item';
     emptyMsg.innerHTML = `<span class="result-name" style="color: var(--text-muted);">No locations found</span>`;
     suggBox.appendChild(emptyMsg);
  } else {
    locations.forEach(loc => {
      const div = document.createElement('div');
      div.className = 'result-item';
      let metaStr = loc.cat_lvl_1 || '';
      if(metaStr && loc.cat_lvl_2) metaStr += ` | ${loc.cat_lvl_2}`;
      div.innerHTML = `<span class="result-name">${escapeHtml(loc.display_name)}</span><span class="result-meta">${escapeHtml(metaStr)}</span>`;
      
      div.onclick = () => selectLocation(loc);
      suggBox.appendChild(div);
    });
  }

  suggBox.classList.add('active');
}

// 2. --- THE DEPARTMENT MENU (Reads your JSON Keywords automatically) ---
function renderFacultyDepartments(allCabinIds) {
  searchInput.value = "Faculty Departments";
  btnClear.style.display = 'flex';
  suggBox.innerHTML = '';

  const backBtn = document.createElement('div');
  backBtn.className = 'category-item';
  backBtn.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
  backBtn.style.position = 'sticky';
  backBtn.style.top = '0';
  backBtn.style.background = 'var(--glass-bg)';
  backBtn.style.backdropFilter = 'blur(12px)';
  backBtn.style.zIndex = '10';
  backBtn.innerHTML = `
    <div class="category-icon" style="background: transparent;">
      <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </div>
    <span class="category-name">Back to Categories</span>
  `;
  backBtn.onclick = (e) => {
    e.stopPropagation();
    searchInput.value = '';
    btnClear.style.display = 'none';
    renderCategories();
  };
  suggBox.appendChild(backBtn);

  // Matches exactly with the keywords in your JSON
  const departments = [
    { name: 'Finance', keywords: ['finance'] },
    { name: 'Marketing', keywords: ['marketing'] },
    { name: 'IT & Operations', keywords: ['it', 'operations'] },
    { name: 'HR & Communication Skills', keywords: ['hr', 'softskills', 'communication'] },
    { name: 'Economics', keywords: ['economics'] }
  ];

  departments.forEach(dept => {
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `
      <div class="category-icon" style="background: rgba(255,255,255,0.05);">
        <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
      </div>
      <span class="category-name">${dept.name}</span>
    `;
    
    div.onclick = (e) => {
      e.stopPropagation();
      
      // Dynamically filter cabins by searching your JSON keywords
      const filteredIds = allCabinIds.filter(id => {
        const loc = mapData.find(l => l.id === id);
        if(!loc) return false;
        const searchableText = [
           loc.cat_lvl_1, loc.cat_lvl_2, loc.cat_lvl_3, 
           loc.description, loc.keywords, loc.display_name
        ].filter(Boolean).join(' ').toLowerCase();
        
        return dept.keywords.some(kw => searchableText.includes(kw));
      });
      
      renderCategoryLocations(dept.name, filteredIds, () => {
         renderFacultyDepartments(allCabinIds);
      });
    };
    
    suggBox.appendChild(div);
  });

  suggBox.classList.add('active');
}

// 3. --- THE MAIN CATEGORY RENDERER (CORRECTED) ---
function renderCategories() {
  suggBox.innerHTML = '';

  const featuredRow = document.createElement('div');
  featuredRow.className = 'featured-categories-row';

  const featuredCats = [
    {
      id: 'cat_classrooms',
      name: 'Classrooms',
      icon: '<svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"/></svg>'
    },
    {
      id: 'cat_faculty_cabins',
      name: 'Faculty Cabins',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>'
    }
  ];

  // FEATURED ROW: Uses the List View
  featuredCats.forEach(cat => {
    const card = document.createElement('div');
    card.className = 'featured-category-card';
    card.innerHTML = `<div class="category-icon">${cat.icon}</div><span class="category-name">${cat.name}</span>`;
    
    card.onclick = (e) => { 
      e.stopPropagation();
      
      let matchedIds = [];
      if (cat.id === 'cat_classrooms') {
        matchedIds = mapData.filter(l => l.cat_lvl_2 === 'Classroom').map(l => l.id);
        renderCategoryLocations(cat.name, matchedIds);
      } 
      else if (cat.id === 'cat_faculty_cabins') {
        matchedIds = mapData.filter(l => l.cat_lvl_2 === 'Faculty cabin').map(l => l.id);
        renderFacultyDepartments(matchedIds); 
      }
    };
    featuredRow.appendChild(card);
  });

  suggBox.appendChild(featuredRow);

  // STANDARD LIST BELOW: Uses the Map View (selectCategory)
  defaultCategories.forEach(cat => {
    const div = document.createElement('div');
    div.className = 'category-item';
    div.innerHTML = `<div class="category-icon">${cat.icon}</div><span class="category-name">${cat.name}</span>`;
    
    div.onclick = (e) => { 
      e.stopPropagation();
      const catData = mapData.find(l => l.id === cat.id);
      if(catData && catData.location_ids) {
        
        // --- THIS PLOTS ON THE MAP ---
        selectCategory(cat.name, catData.location_ids);
        
      } else {
        console.warn("Category data not found in JSON for:", cat.id);
      }
    };
    
    suggBox.appendChild(div);
  });
  
  suggBox.classList.add('active');
}

// --- RECENT SEARCHES MEMORY ---
function getRecentSearches() {
  const stored = localStorage.getItem('campusMapRecentSearches');
  return stored ? JSON.parse(stored) : [];
}

function addRecentSearch(locId) {
  let recents = getRecentSearches();
  // Remove the ID if it's already in the list so we can bump it to the top
  recents = recents.filter(id => id !== locId);
  // Add it to the front of the list
  recents.unshift(locId);
  // Keep only the most recent 5 searches
  if (recents.length > 5) recents.pop();
  localStorage.setItem('campusMapRecentSearches', JSON.stringify(recents));
}

function renderSuggestions() {
  suggBox.innerHTML = '';
  
  // 1. Fetch recent searches from memory
  const recentIds = getRecentSearches();
  const recentLocations = recentIds.map(id => mapData.find(l => l.id === id)).filter(Boolean);

  // 2. If there are recent searches, display them!
  if (recentLocations.length > 0) {
    // Add a tiny header
    const header = document.createElement('div');
    header.style.padding = '16px 20px 8px 20px';
    header.style.fontSize = '12px';
    header.style.fontWeight = '700';
    header.style.color = 'var(--text-muted)';
    header.style.textTransform = 'uppercase';
    header.style.letterSpacing = '0.5px';
    header.innerText = 'Recent Searches';
    suggBox.appendChild(header);

    // List the recent locations
    recentLocations.forEach(loc => {
      const div = document.createElement('div');
      div.className = 'result-item';
      let metaStr = loc.cat_lvl_1 || '';
      if(metaStr && loc.cat_lvl_2) metaStr += ` | ${loc.cat_lvl_2}`;
      
      // Added a small "history/clock" icon next to recent searches
      div.innerHTML = `
        <div style="display: flex; align-items: center; gap: 14px;">
          <svg style="width: 18px; height: 18px; fill: var(--text-muted); flex-shrink: 0;" viewBox="0 0 24 24"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
          <div style="display: flex; flex-direction: column;">
            <span class="result-name" style="margin-bottom: 2px;">${escapeHtml(loc.display_name)}</span>
            <span class="result-meta">${escapeHtml(metaStr)}</span>
          </div>
        </div>`;
        
      div.onclick = () => selectLocation(loc);
      suggBox.appendChild(div);
    });
  }

  // 3. Always show the "Browse Categories" button at the bottom
  const catBtn = document.createElement('div');
  catBtn.className = 'category-item';
  if (recentLocations.length > 0) {
    catBtn.style.borderTop = '1px solid rgba(255,255,255,0.05)';
    catBtn.style.marginTop = '4px';
  }
  
  catBtn.innerHTML = `
    <div class="category-icon" style="background: rgba(66, 133, 244, 0.15); color: var(--accent-blue);">
      <svg viewBox="0 0 24 24"><path d="M9.17 6l2 2H20v10H4V6h5.17M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
    </div>
    <span class="category-name" style="color: var(--accent-blue);">Browse Categories</span>
  `;
  
  catBtn.onclick = (e) => { 
    e.stopPropagation(); 
    searchInput.value = ''; 
    btnClear.style.display = 'none'; 
    renderCategories(); 
  };
  suggBox.appendChild(catBtn);
  suggBox.classList.add('active');
}

function renderResults(matches) {
  suggBox.innerHTML = '';
  if(matches.length === 0) { suggBox.classList.remove('active'); return; }
  matches.forEach(loc => {
    if(loc.system_data) return; 
    const div = document.createElement('div');
    div.className = 'result-item';
    let metaStr = loc.cat_lvl_1 || '';
    if(metaStr && loc.cat_lvl_2) metaStr += ` | ${loc.cat_lvl_2}`;
    div.innerHTML = `<span class="result-name">${escapeHtml(loc.display_name)}</span><span class="result-meta">${escapeHtml(metaStr)}</span>`;
    div.onclick = () => selectLocation(loc);
    suggBox.appendChild(div);
  });
  suggBox.classList.add('active');
}

// Every place whose name, keywords, categories or description contain all the words typed.
function searchPlaces(query) {
  const val = query.toLowerCase().trim();
  if (!val) return [];
  // Split the user's search by spaces so they can type multiple words (e.g. "LT A")
  const searchTerms = val.split(/\s+/);
  const places = mapData.filter(l => !l.system_data && !l.is_category_node);
  const textOf = l => [l.display_name, l.keywords, l.cat_lvl_1, l.cat_lvl_2, l.cat_lvl_3, l.description]
    .filter(Boolean).join(' ').toLowerCase();

  const matches = places.filter(l => {
    const searchableText = textOf(l);
    return searchTerms.every(term => searchableText.includes(term));
  });
  if (matches.length) return matches;

  // Nothing found: compare names without spaces or dashes, so "lta" and "cr20" find "LT - A" and "CR - 20".
  const squash = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const squashed = squash(val);
  return squashed.length < 2 ? [] : places.filter(l => squash(l.display_name || '').includes(squashed));
}

searchInput.addEventListener('input', (e) => {
  const val = e.target.value.toLowerCase().trim();

  // If search is empty, show default suggestions
  if(!val) {
    btnClear.style.display = 'none';
    renderSuggestions();
    return;
  }

  btnClear.style.display = 'flex';
  renderResults(searchPlaces(val));
});

// --- VOICE SEARCH ---
// Tap the mic and say a place. The browser turns speech into text (Chrome and Safari can;
// Firefox can't, so the mic stays hidden there). One clear match opens straight away.
const btnVoiceSearch = document.getElementById('btn-voice-search');
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecognition = null;

// "Where is the library?" and "take me to LT A" should search for "library" and "lt a".
function cleanSpokenQuery(text) {
  return text.toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/^\s*(please\s+)?(where is|where's|take me to|directions to|navigate to|go to|how do i get to|find|show me|show|search for|search)\s+/, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stopVoiceSearch() {
  btnVoiceSearch.classList.remove('listening');
  btnVoiceSearch.setAttribute('aria-pressed', 'false');
  voiceRecognition = null;
}

function startVoiceSearch() {
  const recognition = new SpeechRecognitionApi();
  recognition.lang = 'en-IN';
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  voiceRecognition = recognition;
  btnVoiceSearch.classList.add('listening');
  btnVoiceSearch.setAttribute('aria-pressed', 'true');

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    // Prefer whichever wording the browser offered that actually matches a place.
    const options = Array.from(result).map(alt => cleanSpokenQuery(alt.transcript)).filter(Boolean);
    if (!options.length) return;
    const best = options.find(option => searchPlaces(option).length > 0) || options[0];
    searchInput.value = best;
    btnClear.style.display = 'flex';
    const matches = searchPlaces(best);
    renderResults(matches);
    if (!result.isFinal) return;
    const exact = matches.find(l => l.display_name.toLowerCase() === best);
    if (exact || matches.length === 1) selectLocation(exact || matches[0]);
    else if (matches.length === 0) toast(`No place matches "${best}". Try the building or room name.`);
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('Voice search needs the microphone. Allow it in your browser settings, then tap the mic again.');
    } else if (event.error === 'no-speech') {
      toast('Didn\'t catch that. Tap the mic and say a place, like "Library".');
    } else if (event.error === 'network') {
      toast('Voice search needs an internet connection. You can still type.');
    } else if (event.error !== 'aborted') {
      toast('Voice search didn\'t work this time. You can still type.');
    }
  };
  recognition.onend = () => {
    if (voiceRecognition === recognition) stopVoiceSearch();
  };
  try {
    recognition.start();
  } catch (err) {
    stopVoiceSearch();
    toast('Voice search didn\'t start. You can still type.');
  }
}

if (SpeechRecognitionApi) {
  btnVoiceSearch.hidden = false;
  btnVoiceSearch.addEventListener('click', (e) => {
    e.stopPropagation();
    if (voiceRecognition) voiceRecognition.abort();   // A second tap cancels
    else startVoiceSearch();
  });
}

searchInput.addEventListener('focus', () => { if(searchInput.value === '') renderSuggestions(); });
btnShowCats.addEventListener('click', (e) => { e.stopPropagation(); searchInput.value = ''; btnClear.style.display = 'none'; renderCategories(); });
btnClear.addEventListener('click', (e) => { e.stopPropagation(); clearSelection(); renderSuggestions(); });
if(btnCloseSheet) {
  btnCloseSheet.addEventListener('click', () => { 
    clearSelection(); 
    renderSuggestions(); 
  });
}
document.addEventListener('click', e => { if(!e.target.closest('#search-container')) suggBox.classList.remove('active'); });

btnCollapse.addEventListener('click', () => {
  bottomSheet.classList.toggle('collapsed');
  
  if (bottomSheet.classList.contains('collapsed')) {
    iconCollapse.innerHTML = '<path d="M12 8.5l6 6H6z"/>';
    if(fabBottom) {
      fabBottom.classList.remove('sheet-open');
      fabBottom.classList.add('sheet-collapsed');
    }
    if(joyZone) {
      joyZone.classList.remove('sheet-open');
      joyZone.classList.add('sheet-collapsed');
    }
  } else {
    iconCollapse.innerHTML = '<path d="M12 15.5l-6-6h12z"/>';
    if(fabBottom) {
      fabBottom.classList.remove('sheet-collapsed');
      fabBottom.classList.add('sheet-open');
    }
    if(joyZone) {
      joyZone.classList.remove('sheet-collapsed');
      joyZone.classList.add('sheet-open');
    }
  }
});

function selectLocation(loc) {
  if (!loc.isPin) addRecentSearch(loc.id);
  searchInput.value = loc.display_name;
  suggBox.classList.remove('active');
  btnClear.style.display = 'flex';

  stopNavigation();
  clearMapVisuals();

  selectedLocation = loc;
  document.getElementById('btn-directions').style.display = walkGraph ? 'flex' : 'none';
  document.getElementById('btn-share').style.display = 'flex';

  // Ensure slider is hidden and standard info is visible
  const sliderWrapper = document.getElementById('slider-wrapper');
  if (sliderWrapper) sliderWrapper.style.display = 'none';
  
  const tagsContainerEl = document.getElementById('sheet-tags');
  if (tagsContainerEl) tagsContainerEl.style.display = 'flex';

  // Hide AOD sprites if they exist (handling the array structure)
  if (typeof aodSpritesMap !== 'undefined' && aodSpritesMap.has(loc.id)) {
    aodSpritesMap.get(loc.id).forEach(sprite => sprite.visible = false);
  }

  // Set Info Box text
  document.getElementById('sheet-title').innerText = loc.display_name;
  document.getElementById('sheet-desc').innerText = loc.description || 'Campus Location';
  
  // Apply Auto-Scroll if text is too long
  applyAutoScroll('sheet-title');
  applyAutoScroll('sheet-desc');

  const tagsContainer = document.getElementById('sheet-tags');
  if (tagsContainer) {
    tagsContainer.innerHTML = ''; 
    let tags = [];
    if (loc.cat_lvl_1) tags.push(loc.cat_lvl_1);
    if (loc.cat_lvl_2) tags.push(loc.cat_lvl_2);
    if (loc.cat_lvl_3) tags.push(loc.cat_lvl_3);
    if (tags.length === 0) tags.push('General');

    tags.forEach((tag, index) => {
      const pill = document.createElement('div');
      pill.className = 'tag-pill';
      const dotClass = index === 0 ? 'tag-dot active' : 'tag-dot';
      pill.innerHTML = `<div class="${dotClass}"></div>${escapeHtml(tag)}`;
      tagsContainer.appendChild(pill);
    });
  }

  let nearStr = loc.nearby_1 || '';
  if(nearStr && loc.nearby_2) nearStr += ` • ${loc.nearby_2}`;
  
  const rowNearby = document.getElementById('row-nearby');
  if (rowNearby) {
    if(nearStr) {
      rowNearby.style.display = 'flex';
      document.getElementById('sheet-nearby').innerText = nearStr;
      // Apply Auto-Scroll to nearby text
      applyAutoScroll('sheet-nearby');
    } else {
      rowNearby.style.display = 'none';
    }
  }

  if (bottomSheet) {
      bottomSheet.classList.remove('collapsed');
      document.getElementById('icon-collapse').innerHTML = '<path d="M12 15.5l-6-6h12z"/>';
      bottomSheet.classList.add('open');
      
      if(fabBottom) {
        fabBottom.classList.remove('sheet-collapsed');
        fabBottom.classList.add('sheet-open');
      }
      if(joyZone) {
        joyZone.classList.remove('sheet-collapsed');
        joyZone.classList.add('sheet-open');
      }
  }

  worldGroup.updateMatrixWorld();

  const PIN_FLOAT_HEIGHT = 0.2; 
  const ZOOM_LEVEL_2D = 8;     
  const ZOOM_DIST_3D = 5;     

  let targetWorldPos = new THREE.Vector3();
  let firstTargetSet = false;
  let selectedMeshes = [];
  let markerCreated = false; // Ensures only 1 pin per location

  if (loc._assignment_type === '2d_coords') {
    let coordsArr = Array.isArray(loc.coordinates) ? loc.coordinates : [loc.coordinates];

    coordsArr.forEach(coord => {
      if(!coord) return;
      
      let markerLocalPos = new THREE.Vector3(coord.x, groundY, coord.y);
      let targetRoofY = groundY;
      
      if (!firstTargetSet) {
         targetWorldPos.copy(markerLocalPos).applyMatrix4(worldGroup.matrixWorld);
         firstTargetSet = true;
      }

      if (!markerCreated && typeof createSearchMarker === 'function') {
          createSearchMarker(loc.display_name, markerLocalPos.x, targetRoofY, targetRoofY + PIN_FLOAT_HEIGHT, markerLocalPos.z);
          markerCreated = true;
      }
    });

  } else if (loc._assignment_type === '3d_object') {
    let objectsArr = Array.isArray(loc.glb_objects) ? loc.glb_objects : [loc.glb_objects];

    objectsArr.forEach(meshName => {
      if(!meshName) return;
      const mesh = buildingMeshesMap.get(meshName);
      
      if (mesh) {
        selectedMeshes.push(mesh);
        
        const box = new THREE.Box3().setFromObject(mesh);
        let centerWorld = new THREE.Vector3();
        box.getCenter(centerWorld); 
        let targetRoofY = box.max.y; 
        
        let markerLocalPos = centerWorld.clone();
        worldGroup.worldToLocal(markerLocalPos); 
        
        if (!firstTargetSet) {
           targetWorldPos.copy(centerWorld);
           firstTargetSet = true;
        }

        if (!markerCreated && typeof createSearchMarker === 'function') {
            createSearchMarker(loc.display_name, markerLocalPos.x, targetRoofY, targetRoofY + PIN_FLOAT_HEIGHT, markerLocalPos.z);
            markerCreated = true;
        }
      }
    });

    if (selectedMeshes.length > 0) {
      if (typeof applyGhostingAndHighlight === 'function') applyGhostingAndHighlight(selectedMeshes);
    }
  }

  // Fallback if no target was found to prevent camera breaking
  if(!firstTargetSet) targetWorldPos.set(0, groundY, 0);

  // Glide both cameras to the place
  let calibPolar = Math.PI * 0.35;
  let calibAzimuth = 0;

  const vsData = mapData.find(l => l.id === "view_settings");
  if (vsData && vsData.settings && vsData.settings.v3d) {
      if (vsData.settings.v3d.polar !== undefined) calibPolar = vsData.settings.v3d.polar;
      if (vsData.settings.v3d.azimuth !== undefined) calibAzimuth = vsData.settings.v3d.azimuth;
  }

  glideTo({
    target: targetWorldPos,
    sph3D: new THREE.Spherical(ZOOM_DIST_3D, calibPolar, calibAzimuth),
    zoom2D: ZOOM_LEVEL_2D,
  });
}

function selectCategory(categoryName, locationIds) {
  searchInput.value = categoryName;
  suggBox.classList.remove('active');
  btnClear.style.display = 'flex';

  stopNavigation();
  clearMapVisuals();

  selectedLocation = null;
  document.getElementById('btn-directions').style.display = 'none';
  document.getElementById('btn-share').style.display = 'none';

  // Set Info Box text
  document.getElementById('sheet-title').innerText = categoryName + " Locations";
  document.getElementById('sheet-desc').innerText = `Showing ${locationIds.length} locations on the map.`;
  applyAutoScroll('sheet-title');
  applyAutoScroll('sheet-desc');
  
  // Hide standard single-location details
  const tagsContainer = document.getElementById('sheet-tags');
  if (tagsContainer) tagsContainer.style.display = 'none'; 
  
  const rowNearby = document.getElementById('row-nearby');
  if (rowNearby) rowNearby.style.display = 'none';

  // Show and populate the category slider wrapper
  const sliderWrapper = document.getElementById('slider-wrapper');
  const catSlider = document.getElementById('category-slider');
  
  if (sliderWrapper && catSlider) {
    sliderWrapper.style.display = 'block';
    catSlider.innerHTML = ''; // Clear old cards

    locationIds.forEach(locId => {
      const locData = mapData.find(l => l.id === locId);
      if (!locData) return;

      const card = document.createElement('div');
      card.className = 'slider-card';

      // Build nearby string for the card
      let nearStr = locData.nearby_1 || '';
      if(nearStr && locData.nearby_2) nearStr += ` • ${locData.nearby_2}`;
      if(!nearStr) nearStr = locData.description || 'No nearby info';

      card.innerHTML = `
        <div class="slider-card-title">${escapeHtml(locData.display_name)}</div>
        <div class="slider-card-desc">${escapeHtml(nearStr)}</div>
      `;

      // When clicked, open this specific location!
      card.onclick = () => { selectLocation(locData); };
      catSlider.appendChild(card);
    });
  }

  if (bottomSheet) {
      bottomSheet.classList.remove('collapsed');
      document.getElementById('icon-collapse').innerHTML = '<path d="M12 15.5l-6-6h12z"/>';
      bottomSheet.classList.add('open');
      
      if(fabBottom) {
        fabBottom.classList.remove('sheet-collapsed');
        fabBottom.classList.add('sheet-open');
      }
      if(joyZone) {
        joyZone.classList.remove('sheet-collapsed');
        joyZone.classList.add('sheet-open');
      }
  }

  worldGroup.updateMatrixWorld();

  // Zoom parameters adapted for wider category view
  const PIN_FLOAT_HEIGHT = 0.2; 
  const ZOOM_LEVEL_2D = 3;     
  const ZOOM_DIST_3D = 20;     

  let targetWorldPos = new THREE.Vector3();
  let selectedMeshes = [];
  let sumX = 0, sumZ = 0, targetCount = 0;

  // Loop through all IDs specified in the JSON category
  locationIds.forEach(locId => {
    const loc = mapData.find(l => l.id === locId);
    if (!loc) return;

    // Hide AOD sprites if they exist (handling the array structure)
    if (typeof aodSpritesMap !== 'undefined' && aodSpritesMap.has(loc.id)) {
      aodSpritesMap.get(loc.id).forEach(sprite => sprite.visible = false);
    }

    let markerCreated = false; // Ensures only 1 pin per location

    if (loc._assignment_type === '2d_coords') {
      let coordsArr = Array.isArray(loc.coordinates) ? loc.coordinates : [loc.coordinates];

      coordsArr.forEach(coord => {
        if(!coord) return;
        let markerLocalPos = new THREE.Vector3(coord.x, groundY, coord.y);
        let targetRoofY = groundY;
        
        let worldP = markerLocalPos.clone().applyMatrix4(worldGroup.matrixWorld);
        sumX += worldP.x; sumZ += worldP.z; targetCount++;

        if (!markerCreated && typeof createSearchMarker === 'function') {
            createSearchMarker(loc.display_name, markerLocalPos.x, targetRoofY, targetRoofY + PIN_FLOAT_HEIGHT, markerLocalPos.z);
            markerCreated = true;
        }
      });

    } else if (loc._assignment_type === '3d_object') {
      let objectsArr = Array.isArray(loc.glb_objects) ? loc.glb_objects : [loc.glb_objects];

      objectsArr.forEach(meshName => {
        if(!meshName) return;
        const mesh = buildingMeshesMap.get(meshName);
        
        if (mesh) {
          selectedMeshes.push(mesh);
          
          const box = new THREE.Box3().setFromObject(mesh);
          let centerWorld = new THREE.Vector3();
          box.getCenter(centerWorld); 
          let targetRoofY = box.max.y; 
          
          let markerLocalPos = centerWorld.clone();
          worldGroup.worldToLocal(markerLocalPos); 
          
          sumX += centerWorld.x; sumZ += centerWorld.z; targetCount++;

          if (!markerCreated && typeof createSearchMarker === 'function') {
              createSearchMarker(loc.display_name, markerLocalPos.x, targetRoofY, targetRoofY + PIN_FLOAT_HEIGHT, markerLocalPos.z);
              markerCreated = true;
          }
        }
      });
    }
  });

  // Apply ghosting to all collected 3D meshes
  if (selectedMeshes.length > 0) {
    if (typeof applyGhostingAndHighlight === 'function') applyGhostingAndHighlight(selectedMeshes);
  }

  // Calculate the center point of all locations for the camera
  if (targetCount > 0) {
    targetWorldPos.set(sumX / targetCount, groundY, sumZ / targetCount);
  } else {
    targetWorldPos.set(0, groundY, 0);
  }

  // Glide both cameras to the centre of the category's places
  let calibPolar = Math.PI * 0.35;
  let calibAzimuth = 0;

  const vsData = mapData.find(l => l.id === "view_settings");
  if (vsData && vsData.settings && vsData.settings.v3d) {
      if (vsData.settings.v3d.polar !== undefined) calibPolar = vsData.settings.v3d.polar;
      if (vsData.settings.v3d.azimuth !== undefined) calibAzimuth = vsData.settings.v3d.azimuth;
  }

  glideTo({
    target: targetWorldPos,
    sph3D: new THREE.Spherical(ZOOM_DIST_3D, calibPolar, calibAzimuth),
    zoom2D: ZOOM_LEVEL_2D,
  });
}

function clearSelection() {
  searchInput.value = '';
  btnClear.style.display = 'none';

  stopNavigation();
  selectedLocation = null;
  document.getElementById('btn-share').style.display = 'none';
  bottomSheet.classList.remove('open');
  
  if (fabBottom) {
    fabBottom.classList.remove('sheet-open');
    fabBottom.classList.remove('sheet-collapsed');
  }

  if (joyZone) {
    joyZone.classList.remove('sheet-open');
    joyZone.classList.remove('sheet-collapsed');
  }

  // Hide the category slider wrapper
  const sliderWrapper = document.getElementById('slider-wrapper');
  if (sliderWrapper) sliderWrapper.style.display = 'none';
  
  clearMapVisuals();
  
  // Turn all AOD sprites back on (handling the array structure)
  aodSpritesMap.forEach(spritesArray => {
    spritesArray.forEach(sprite => sprite.visible = true);
  });
}

function applyDefaultAesthetic() {
  worldGroup.updateMatrixWorld(true);
  buildingMeshesMap.forEach((mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    const height = box.max.y - box.min.y;
    const isGroundPlane = /^Plane/i.test(mesh.name || '');

    if (height > 0.05 && !isGroundPlane) {
      mesh.material = mesh.userData.defaultMat || defaultBuildingMat;
    } else {
      if (typeof originalMaterials !== 'undefined' && originalMaterials.has(mesh.uuid)) {
        mesh.material = originalMaterials.get(mesh.uuid);
      }
    }
  });
}

function clearMapVisuals() {
  while(searchPinGroup.children.length > 0){ 
      searchPinGroup.remove(searchPinGroup.children[0]); 
  }
  if (activeHighlightMeshes && activeHighlightMeshes.length > 0) {
    activeHighlightMeshes.forEach(mesh => {
      if (mesh.userData.baseScale) {
        mesh.scale.copy(mesh.userData.baseScale);
      }
    });
  }
  applyDefaultAesthetic(); 
  activeHighlightMeshes = [];
  if (typeof updateBuildingVisibility === 'function') updateBuildingVisibility();
}

function applyGhostingAndHighlight(selectedMeshes) {
  const highlightMat = new THREE.MeshStandardMaterial({ 
    color: 0x4285f4, emissive: 0x174ea6, emissiveIntensity: 0.4, transparent: true, opacity: 0.95 
  });
  
  const searchGhostMat = defaultBuildingMat.clone();
  searchGhostMat.opacity = 0.5; 

  activeHighlightMeshes = selectedMeshes; // Store the array

  buildingMeshesMap.forEach((mesh) => {
    if (selectedMeshes.includes(mesh)) {
      mesh.material = highlightMat;
    } else {
      const box = new THREE.Box3().setFromObject(mesh);
      const height = box.max.y - box.min.y;
      const isGroundPlane = /^Plane/i.test(mesh.name || '');

      if (height > 0.05 && !isGroundPlane) {
        mesh.material = searchGhostMat;
      } else {
        if (typeof originalMaterials !== 'undefined' && originalMaterials.has(mesh.uuid)) {
          mesh.material = originalMaterials.get(mesh.uuid);
        }
      }
    }
  });
  updateBuildingVisibility();
}

function createSearchMarker(text, x, bottomY, topY, z) {
  // --- TEXT BOX CONTROLS ---
  const GLASS_BG = 'rgba(255, 255, 255, 0.85)'; 
  const BORDER_COLOR = 'rgba(18, 19, 24, 0.85)'; 
  const TEXT_COLOR = '#121318'; 
  const TEXT_BOX_BORDER_WIDTH = 4; 
  
  // ---> NEW PREMIUM SOLID PIN CONTROLS <---
  const PIN_BORDER = '#ffffff'; // Exact toggle button blue
  const PIN_BORDER_WIDTH = 3;   // Thick, bold accent edge
  const DOT_COLOR = '#ffffff';  // Crisp white inner dot
  
  const TEXT_SIZE = 48;               
  const SPRITE_SCALE = 0.006; 

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `900 ${TEXT_SIZE}px "Inter", sans-serif`; 
  const metrics = ctx.measureText(text);
  
  const boxWidth = metrics.width + 60; 
  canvas.width = Math.max(200, boxWidth + 40); 
  canvas.height = 230; 
  
  const ctx2 = canvas.getContext('2d');
  ctx2.font = `900 ${TEXT_SIZE}px "Inter", sans-serif`;
  ctx2.textAlign = 'center';
  ctx2.textBaseline = 'middle';
  
  const centerX = canvas.width / 2;
  const pillHeight = 80;
  const pillY = 20;
  
  // 1. Draw Text Box
  ctx2.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx2.shadowBlur = 15; 
  ctx2.shadowOffsetY = 6;
  
  ctx2.fillStyle = GLASS_BG; 
  ctx2.strokeStyle = BORDER_COLOR;
  ctx2.lineWidth = TEXT_BOX_BORDER_WIDTH; 
  
  ctx2.beginPath();
  ctx2.roundRect(centerX - boxWidth/2, pillY, boxWidth, pillHeight, pillHeight/2);
  ctx2.fill();
  ctx2.stroke();
  
  ctx2.shadowBlur = 0; 
  ctx2.shadowOffsetY = 0;
  ctx2.fillStyle = TEXT_COLOR; 
  ctx2.fillText(text, centerX, pillY + pillHeight/2 + 3);

  const pinGap = 60; 
  const pinY = pillY + pillHeight + pinGap; 
  
  // 2. Create the Dark "Matte Texture" Gradient for the Pin
  // This simulates the sleek dark theme of your UI panels
  const pinGradient = ctx2.createLinearGradient(centerX - 20, pinY - 45, centerX + 20, pinY + 15);
  pinGradient.addColorStop(0, '#2a2d39'); // Lighter dark at the top
  pinGradient.addColorStop(1, '#121318'); // Deep background color at the bottom
  
  // 3. Draw the Solid, Themed Pin
  ctx2.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx2.shadowBlur = 12; 
  ctx2.shadowOffsetY = 6;

  ctx2.beginPath();
  ctx2.arc(centerX, pinY - 25, 22, Math.PI * 0.18, Math.PI * 0.82, true); 
  ctx2.lineTo(centerX, pinY + 12); 
  ctx2.closePath();
  
  // Apply the solid dark UI texture
  ctx2.fillStyle = pinGradient;
  ctx2.fill();
  
  // Apply the glowing blue border
  ctx2.strokeStyle = PIN_BORDER; 
  ctx2.lineWidth = PIN_BORDER_WIDTH; 
  ctx2.stroke();

  // 4. Draw Crisp Inner Dot
  ctx2.shadowBlur = 0; 
  ctx2.shadowOffsetY = 0;
  ctx2.beginPath();
  ctx2.arc(centerX, pinY - 25, 6, 0, Math.PI * 2);
  ctx2.fillStyle = DOT_COLOR;
  ctx2.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  
  const spriteMat = new THREE.SpriteMaterial({ 
    map: tex, 
    depthTest: false,
    transparent: true,
    color: new THREE.Color(1.0, 1.0, 1.0) 
  });
  const sprite = new THREE.Sprite(spriteMat);
  
  const anchorY = 1.0 - ((pinY + 15) / canvas.height); 
  sprite.center.set(0.5, anchorY);
  
  sprite.scale.set(canvas.width * SPRITE_SCALE, canvas.height * SPRITE_SCALE, 1);
  sprite.position.set(x, topY, z);
  sprite.renderOrder = 999; 
  
  sprite.userData.baseScale = new THREE.Vector2(canvas.width * SPRITE_SCALE, canvas.height * SPRITE_SCALE);
  sprite.userData.isSearchMarker = true; 
  searchPinGroup.add(sprite);
}
  
function createPUBGLabel(text, x, z, yOffset) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '900 48px "Inter", sans-serif'; 
  const metrics = ctx.measureText(text);
  canvas.width = metrics.width + 40; 
  canvas.height = 80;
  
  const ctx2 = canvas.getContext('2d');
  ctx2.font = '900 48px "Inter", sans-serif';
  ctx2.textAlign = 'center';
  ctx2.textBaseline = 'middle';
  
  ctx2.lineWidth = 10;
  ctx2.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx2.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx2.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx2.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  
  const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(spriteMat);
  
  const scale = 0.005; 
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.position.set(x, yOffset, z); 
  sprite.renderOrder = 998; 
  
  sprite.userData.baseScale = new THREE.Vector2(canvas.width * scale, canvas.height * scale);
  return sprite;
}

function generatePUBGLabels() {
  mapData.forEach(loc => {
    if (loc.always_on_display === 1 || loc.always_on_display === "1") {
      let spritesForLoc = []; // Array to hold multiple labels if needed

      if (loc._assignment_type === '2d_coords' && loc.coordinates) {
        // Handle both single coordinate objects and arrays of coordinates
        let coordsArr = Array.isArray(loc.coordinates) ? loc.coordinates : [loc.coordinates];

        coordsArr.forEach(coord => {
          if (coord && coord.x !== undefined && coord.y !== undefined) {
            // Note: coord.y from JSON maps to the Z axis in 3D space
            const labelSprite = createPUBGLabel(loc.display_name, coord.x, coord.y, groundY + 0.3);
            pubgLabelsGroup.add(labelSprite);
            spritesForLoc.push(labelSprite);
          }
        });

      } else if (loc._assignment_type === '3d_object' && loc.glb_objects) {
        // Handle both single mesh strings and arrays of strings
        let objectsArr = Array.isArray(loc.glb_objects) ? loc.glb_objects : [loc.glb_objects];

        objectsArr.forEach(meshName => {
          if(!meshName) return;
          const mesh = buildingMeshesMap.get(meshName);
          if (mesh) {
            const box = new THREE.Box3().setFromObject(mesh);
            const center = new THREE.Vector3();
            box.getCenter(center);
            let yOffset = box.max.y + 0.5; 
            
            worldGroup.worldToLocal(center); 
            
            const labelSprite = createPUBGLabel(loc.display_name, center.x, center.z, yOffset);
            pubgLabelsGroup.add(labelSprite);
            spritesForLoc.push(labelSprite);
          }
        });
      }

      // Save the array of sprites to the map so they can be hidden when searched
      if (spritesForLoc.length > 0) {
        aodSpritesMap.set(loc.id, spritesForLoc);
      }
    }
  });
}

function applyCameraOffset() {
  // 120 pixels pushes the "center" of the map higher up the screen
  // so the bottom sheet never blocks the location you search for!
  const yOffset = 120;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // While navigating, you sit low on the screen so more of the way ahead shows.
  const navOffset = document.body.classList.contains('navigating') ? -Math.round(h * 0.18) : yOffset;

  if (camera2D) camera2D.setViewOffset(w, h, 0, yOffset, w, h);
  if (camera3D) camera3D.setViewOffset(w, h, 0, navOffset, w, h);
}

function initThree() {
  const canvas = document.getElementById('map-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  // Phones report 3x; drawing that many pixels costs battery and looks the same as 2x.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // Shadows are redrawn only when buildings move or change (see animate), not every frame.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
  sunLight.position.set(40, 80, 40);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  scene.add(sunLight.target);

  scene.add(worldGroup);

  camera2D = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  camera3D = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 5000);
  applyCameraOffset();
  controls2D = new OrbitControls(camera2D, canvas);
  controls2D.enableRotate = true; // Allow twisting in 2D
  controls2D.minPolarAngle = 0;   // Lock tilt so it stays perfectly top-down
  controls2D.maxPolarAngle = 0;   // Lock tilt so it stays perfectly top-down
  controls2D.enableDamping = true;
  controls2D.dampingFactor = 0.1;

  controls3D = new OrbitControls(camera3D, canvas);
  controls3D.enableDamping = true;
  controls3D.dampingFactor = 0.1;
  controls3D.maxPolarAngle = Math.PI * 0.45;
  controls3D.minDistance = 0.8;   // About 30 m: closer than this you end up inside a building
  controls3D.maxDistance = 35;    // Far enough to see the whole campus
  // Touching the map cancels any camera glide in progress.
  controls2D.addEventListener('start', cancelGlide);
  controls3D.addEventListener('start', cancelGlide);
  // Dragging the map while navigating stops it following you, like Google Maps.
  controls3D.addEventListener('start', () => {
    if (navState && navState.mode === 'active') {
      navFollow = false;
      document.getElementById('btn-recenter').classList.add('visible');
    }
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera3D.aspect = window.innerWidth / window.innerHeight;
    camera3D.updateProjectionMatrix();
    // Route lines are sized in pixels, so they need the new canvas size.
    navGroup.children.forEach(child => {
      if (child.material && child.material.isLineMaterial) {
        child.material.resolution.set(renderer.domElement.width, renderer.domElement.height);
      }
    });
    if(modelBounds) fitOrthoToMobileScreen();
    applyCameraOffset();
  });

  // Assign Touch Actions: 1 Finger = Pan, 2 Fingers = Zoom, Twist, & Tilt
  controls2D.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls3D.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }; // Unlocks 3D twisting and tilting!
}

function setupCameras(gY) {
  const viewSettingsData = mapData.find(l => l.id === "view_settings");
  const center = new THREE.Vector3();
  modelBounds.getCenter(center);
  const size = new THREE.Vector3();
  modelBounds.getSize(size);
  
  fitOrthoToMobileScreen();

  if (viewSettingsData && viewSettingsData.settings) {
    const vs = viewSettingsData.settings;
    if (vs.visuals) {
      renderer.toneMappingExposure = vs.visuals.exposure !== undefined ? vs.visuals.exposure : 1.0;
      const canvas = document.getElementById('map-canvas');
      canvas.style.filter = `brightness(${vs.visuals.brightness}) contrast(${vs.visuals.contrast}) saturate(${vs.visuals.saturation})`;
    }
    if (vs.v2d) {
      camera2D.position.set(vs.v2d.x, center.y + 200, vs.v2d.z);
      camera2D.zoom = vs.v2d.zoom;
      controls2D.target.set(vs.v2d.x, gY, vs.v2d.z);
      camera2D.updateProjectionMatrix();
    }
    if (vs.v3d) {
      controls3D.target.set(vs.v3d.x, gY, vs.v3d.z);
      const sph = new THREE.Spherical(vs.v3d.distance, vs.v3d.polar, vs.v3d.azimuth);
      camera3D.position.setFromSpherical(sph).add(controls3D.target);
      controls3D.update();
    }
  }
}

function fitOrthoToMobileScreen() {
  if (!modelBounds) return;
  const aspect = window.innerWidth / window.innerHeight;
  const sizeX = modelBounds.max.x - modelBounds.min.x;
  const sizeZ = modelBounds.max.z - modelBounds.min.z;
  
  let halfX = (sizeX * 1.05) / 2;
  let halfZ = (sizeZ * 1.05) / 2;
  if (halfX / aspect > halfZ) halfZ = halfX / aspect;
  else halfX = halfZ * aspect;
  
  const zoom = camera2D.zoom || 1;
  camera2D.left = -halfX; camera2D.right = halfX;
  camera2D.top = halfZ; camera2D.bottom = -halfZ;
  camera2D.zoom = zoom;
  camera2D.updateProjectionMatrix();
}

document.getElementById('btn-2d').addEventListener('click', () => setMode('2d'));
document.getElementById('btn-3d').addEventListener('click', () => setMode('3d'));

// --- ZOOM BUTTONS LOGIC ---
// Each tap zooms from where the last tap was heading, so quick double taps add up.
function zoomBy(factor2D, factor3D) {
  const goal = glide ? glide.end : null;
  if (activeCamera === camera2D) {
    const zoom = (goal ? goal.zoom : camera2D.zoom) * factor2D;
    glideTo({ zoom2D: Math.max(0.5, Math.min(40, zoom)), duration: 300 });
  } else if (activeCamera === camera3D) {
    const sph = goal ? goal.sph.clone()
      : new THREE.Spherical().setFromVector3(camera3D.position.clone().sub(controls3D.target));
    sph.radius = THREE.MathUtils.clamp(sph.radius * factor3D, Math.max(2, controls3D.minDistance), controls3D.maxDistance);
    glideTo({ sph3D: sph, duration: 300 });
  }
}

document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.3, 0.75));
document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.3, 1.33));

// --- COMPASS CLICK LOGIC (Reset View) ---
document.getElementById('btn-compass').addEventListener('click', () => {
  const vsData = mapData.find(l => l.id === "view_settings");
  
  if (activeCamera === camera3D) {
    let defAzimuth = 0;
    let defPolar = Math.PI * 0.35;
    if (vsData && vsData.settings && vsData.settings.v3d) {
      if (vsData.settings.v3d.azimuth !== undefined) defAzimuth = vsData.settings.v3d.azimuth;
      if (vsData.settings.v3d.polar !== undefined) defPolar = vsData.settings.v3d.polar;
    }
    const offset = new THREE.Vector3().copy(camera3D.position).sub(controls3D.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta = defAzimuth;
    sph.phi = defPolar;
    glideTo({ sph3D: sph, duration: 600 });
  } else if (activeCamera === camera2D) {
    let defZoom = 3;
    if (vsData && vsData.settings && vsData.settings.v2d && vsData.settings.v2d.zoom !== undefined) {
      defZoom = vsData.settings.v2d.zoom;
    }
    fitOrthoToMobileScreen(); // Resets bounding box
    glideTo({ zoom2D: defZoom, duration: 600 });
  }
});

function updateBuildingVisibility() {
  const is2D = document.getElementById('btn-2d').classList.contains('active');
  // With the realistic shell in place, the room boxes inside it only show while a
  // room is selected; the shell turns see-through so the lit-up room is visible.
  const roomSelected = activeHighlightMeshes.length > 0;
  const showRooms = !shellGroup || roomSelected;

  buildingMeshesMap.forEach((mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    const height = box.max.y - box.min.y;
    const isGroundPlane = /^Plane/i.test(mesh.name || '');

    if (height > 0.05 && !isGroundPlane) {
      mesh.visible = !is2D && showRooms;
    } else {
      mesh.visible = true;
    }
  });
  if (shellGroup) {
    shellGroup.visible = !is2D;
    setShellGhost(roomSelected);
  }
  shadowsDirty = true;
}

// --- 3D VIEW: THE REAL ACADEMIC BLOCK ---
// model.glb only has a box per room. This draws the building itself around them: real outlines
// traced from the aerial photo (tools/build_campus_shell.py), that photo on the roofs, plaster
// walls with a row of windows per storey, the dome, the IBS mural wall and the entrance porches.
let shellGroup = null;
const shellGhostMat = new THREE.MeshStandardMaterial({
  color: 0xcfd6e6, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide,
});

function setShellGhost(ghost) {
  shellGroup.traverse(obj => {
    if (obj.isMesh) obj.material = ghost ? shellGhostMat : obj.userData.realMat;
  });
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// One storey of wall, two windows wide. It repeats along and up every wall.
function makeWallTexture() {
  const tex = canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#d9c9b8';                      // Cream-pink plaster, as in the photos
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(120, 100, 85, 0.25)';     // A faint line where the floors meet
    ctx.fillRect(0, h - 8, w, 8);
    [70, 326].forEach(x => {
      ctx.fillStyle = '#f1ebe2';                    // Window frame
      ctx.fillRect(x - 8, 62, 132, 132);
      const glass = ctx.createLinearGradient(0, 70, 0, 186);
      glass.addColorStop(0, '#5d6b78');
      glass.addColorStop(1, '#2c343c');
      ctx.fillStyle = glass;
      ctx.fillRect(x, 70, 116, 116);
      ctx.fillStyle = '#f1ebe2';                    // Glazing bars
      ctx.fillRect(x + 55, 70, 6, 116);
      ctx.fillRect(x, 124, 116, 6);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';        // Shadow under the sill
      ctx.fillRect(x - 8, 194, 132, 6);
    });
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeMuralTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const stripes = ['#d6337a', '#f2c230', '#3aa655', '#2f6fd0', '#f07a2b'];
    stripes.forEach((colour, i) => {
      ctx.fillStyle = colour;
      ctx.fillRect(i * w / stripes.length, 0, w / stripes.length + 1, h);
    });
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = '900 210px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('IBS', w / 2, h * 0.42);
  });
}

function makeSignTexture() {
  return canvasTexture(2048, 128, (ctx, w, h) => {
    ctx.fillStyle = '#efe8dc';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#a8842c';
    ctx.font = '700 76px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('The ICFAI Foundation for Higher Education', w / 2, h / 2 + 4);
  });
}

function shellMesh(positions, uvs, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.realMat = material;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildCampusShell(data) {
  const { bounds, floorHeight } = data;
  const WALL_TILE = 0.2;      // Width of one wall tile (two windows), about 7.5 m
  const PARAPET = 0.025;      // The low wall around each roof
  const y0 = groundY;

  const roofTex = new THREE.TextureLoader().load(data.roofImage, () => { shadowsDirty = true; });
  roofTex.colorSpace = THREE.SRGBColorSpace;
  roofTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const side = THREE.DoubleSide;
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 1, side });
  // The scene is lit brightly for the satellite photo, so the plaster is tinted down to stay cream, not white.
  const wallMat = new THREE.MeshStandardMaterial({ map: makeWallTexture(), color: 0xdccfc9, roughness: 0.9, side });
  const plainMat = new THREE.MeshStandardMaterial({ color: 0xc3b4ab, roughness: 0.9, side });
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0xbdb6ac, roughness: 0.8 });
  // The roof photo is laid out north-up; this finds a model point on it.
  const roofUv = (x, z) => [
    (bounds.zMax - z) / (bounds.zMax - bounds.zMin),
    1 - (x - bounds.xMin) / (bounds.xMax - bounds.xMin),
  ];

  const group = new THREE.Group();
  const roofPos = [], roofUvs = [], wallPos = [], wallUvs = [], plainPos = [], plainUvs = [];
  const quad = (pos, uvs, a, b, yLow, yHigh, u0, u1, v0, v1) => {
    pos.push(a.x, yLow, a.y, b.x, yLow, b.y, b.x, yHigh, b.y, a.x, yLow, a.y, b.x, yHigh, b.y, a.x, yHigh, a.y);
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  };

  data.blocks.forEach(block => {
    const pts = block.points.map(([x, z]) => new THREE.Vector2(x, z));
    const top = y0 + block.floors * floorHeight;
    const isPergola = block.kind === 'pergola';

    // Roof: the outline filled in, showing the aerial photo of this very roof.
    THREE.ShapeUtils.triangulateShape(pts, []).forEach(tri => tri.forEach(i => {
      roofPos.push(pts[i].x, top, pts[i].y);
      roofUvs.push(...roofUv(pts[i].x, pts[i].y));
    }));

    let along = 0;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const len = a.distanceTo(b);
      if (isPergola) {
        // Open porch: a pillar at each corner and every few metres between.
        const count = Math.max(1, Math.round(len / 0.13));
        for (let k = 0; k < count; k++) {
          const p = a.clone().lerp(b, k / count);
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.022, top - y0, 0.022), pillarMat);
          pillar.position.set(p.x, (top + y0) / 2, p.y);
          pillar.userData.realMat = pillarMat;
          pillar.castShadow = true;
          group.add(pillar);
        }
        quad(plainPos, plainUvs, a, b, top - 0.02, top, 0, 1, 0, 1);   // The beam along the edge
      } else {
        quad(wallPos, wallUvs, a, b, y0, top, along / WALL_TILE, (along + len) / WALL_TILE, 0, block.floors);
        quad(plainPos, plainUvs, a, b, top, top + PARAPET, 0, 1, 0, 1);
      }
      along += len;
    });
  });

  group.add(shellMesh(roofPos, roofUvs, roofMat), shellMesh(wallPos, wallUvs, wallMat), shellMesh(plainPos, plainUvs, plainMat));

  // The dome: a low drum with a slate-grey cap, as it looks from the courtyard.
  const { center, radius, floors } = data.dome;
  const domeBase = y0 + floors * floorHeight;
  const drumMat = plainMat;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.05, 40), drumMat);
  drum.position.set(center[0], domeBase + 0.025, center[1]);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x4b525b, roughness: 0.45, metalness: 0.5 });
  const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.04, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
  cap.scale.y = 0.55;
  cap.position.set(center[0], domeBase + 0.05, center[1]);
  const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 8), capMat);
  finial.position.set(center[0], domeBase + 0.05 + radius * 0.57 + 0.03, center[1]);
  [drum, cap, finial].forEach(mesh => {
    mesh.userData.realMat = mesh.material;
    mesh.castShadow = true;
    group.add(mesh);
  });

  // Flat panels that sit just proud of a wall, turned to face outwards.
  const panel = (spec, width, height, y, texture) => {
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, side });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
    const [fx, fz] = spec.facing;
    mesh.position.set(spec.center[0] + fx * 0.006, y, spec.center[1] + fz * 0.006);
    mesh.rotation.y = Math.atan2(fx, fz);
    mesh.userData.realMat = mat;
    group.add(mesh);
  };
  const muralHeight = data.mural.floorsHigh * floorHeight;
  panel(data.mural, data.mural.width, muralHeight, y0 + muralHeight / 2, makeMuralTexture());
  panel(data.sign, data.sign.width, data.sign.width / 16, y0 + 2 * floorHeight + data.sign.width / 32, makeSignTexture());

  return group;
}

function loadCampusShell() {
  fetch('data/campus-shell.json')
    .then(r => { if (!r.ok) throw new Error(`campus-shell.json returned ${r.status}`); return r.json(); })
    .then(data => {
      shellGroup = buildCampusShell(data);
      worldGroup.add(shellGroup);
      updateBuildingVisibility();
    })
    .catch(err => {
      // The room boxes still show without it, as they did before.
      console.error('Realistic building unavailable:', err);
    });
}

// --- 3D VIEW: BUILDINGS, SUN, MIST ---
const BUILDING_SHADES = [0x7a84a3, 0x8892b0, 0x99a4c6, 0xadb7da]; // Shortest to tallest
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function isBuildingMesh(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  return box.max.y - box.min.y > 0.05 && !/^Plane/i.test(mesh.name || '');
}

// Taller blocks get a lighter shade and every block gets outlined edges,
// so neighbouring buildings are easy to tell apart. Buildings cast shadows.
function prepareBuildings() {
  const buildings = [];
  buildingMeshesMap.forEach(mesh => {
    // Flat meshes are ground tiles (the loader strips the dot from "Plane.001", so they land here).
    if (!isBuildingMesh(mesh)) {
      mesh.receiveShadow = true;
      return;
    }
    const box = new THREE.Box3().setFromObject(mesh);
    buildings.push({ mesh, height: box.max.y - box.min.y });
  });
  if (!buildings.length) return;

  const shadeMats = BUILDING_SHADES.map(color => {
    const mat = defaultBuildingMat.clone();
    mat.color.set(color);
    return mat;
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xe8eaed, transparent: true, opacity: 0.35, depthWrite: false });
  const sorted = buildings.map(b => b.height).sort((a, b) => a - b);

  buildings.forEach(({ mesh, height }) => {
    const rank = sorted.indexOf(height) / sorted.length;
    mesh.userData.defaultMat = shadeMats[Math.min(shadeMats.length - 1, Math.floor(rank * shadeMats.length))];
    mesh.castShadow = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMat);
    edges.raycast = () => {};
    mesh.add(edges);
  });
}

function setupSunAndFog() {
  worldGroup.updateMatrixWorld(true);
  worldBox = new THREE.Box3().setFromObject(worldGroup);
  const center = worldBox.getCenter(new THREE.Vector3());
  const radius = worldBox.getSize(new THREE.Vector3()).length() / 2;

  // Afternoon sun from the south-west, with its shadow box covering the whole campus.
  sunLight.target.position.copy(center);
  sunLight.position.copy(center).add(new THREE.Vector3(-0.5, 1, 0.6).normalize().multiplyScalar(radius * 2));
  const cam = sunLight.shadow.camera;
  cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
  cam.near = 0.1; cam.far = radius * 4;
  cam.updateProjectionMatrix();
  shadowsDirty = true;
}

// Mist hides the edge of the satellite photo when the 3D view is tilted.
// It scales with zoom: distant blocks fade, nearby ones stay sharp.
function updateFog() {
  if (activeCamera !== camera3D) {
    scene.fog = null;
    return;
  }
  const dist = camera3D.position.distanceTo(controls3D.target);
  if (!scene.fog) scene.fog = new THREE.Fog(BACKGROUND_COLOR, 1, 2);
  scene.fog.near = Math.max(6, dist * 1.3);
  scene.fog.far = Math.max(14, dist * 2.8);
}

// Keeps the point you look at over the campus, so dragging can't leave you staring at nothing.
function clampToCampus(controls, camera) {
  if (!worldBox) return;
  const t = controls.target;
  const center = worldBox.getCenter(_labelPos);
  const halfX = (worldBox.max.x - worldBox.min.x) * 0.45;   // Stay within 90% of the campus
  const halfZ = (worldBox.max.z - worldBox.min.z) * 0.45;
  const x = THREE.MathUtils.clamp(t.x, center.x - halfX, center.x + halfX);
  const z = THREE.MathUtils.clamp(t.z, center.z - halfZ, center.z + halfZ);
  if (x === t.x && z === t.z) return;
  camera.position.x += x - t.x;
  camera.position.z += z - t.z;
  t.x = x;
  t.z = z;
}

// --- SMOOTH CAMERA GLIDES ---
// Every jump of the camera (picking a place, a route, zoom buttons, reset) glides instead.
let glide = null;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cancelGlide() { glide = null; }

// target: a world point both cameras should centre on. sph3D: the 3D camera's distance and angles
// around that point. zoom2D: the 2D zoom. Leave any of them out to keep the current value.
function glideTo({ target, sph3D, zoom2D, duration = 900 }) {
  const from3D = new THREE.Spherical().setFromVector3(camera3D.position.clone().sub(controls3D.target));
  const to3D = sph3D ? sph3D.clone() : from3D.clone();
  // Turn the short way round.
  let dTheta = to3D.theta - from3D.theta;
  dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
  const start = {
    target3D: controls3D.target.clone(),
    target2D: controls2D.target.clone(),
    sph: from3D,
    zoom: camera2D.zoom,
  };
  const end = {
    target3D: target ? target.clone() : start.target3D.clone(),
    target2D: target ? target.clone() : start.target2D.clone(),
    sph: new THREE.Spherical(to3D.radius, to3D.phi, from3D.theta + dTheta),
    zoom: zoom2D || start.zoom,
  };
  // Long trips pull back a little mid-way, so you can see where you are going.
  const lift = Math.min(8, start.target3D.distanceTo(end.target3D) * 0.35);
  glide = { start, end, lift, startTime: performance.now(), duration: reducedMotion.matches ? 0 : duration };
  stepGlide(performance.now());
}

function stepGlide(now) {
  if (!glide) return;
  const { start, end, lift, startTime, duration } = glide;
  const t = duration > 0 ? Math.min(1, (now - startTime) / duration) : 1;
  const e = easeInOutCubic(t);

  controls3D.target.lerpVectors(start.target3D, end.target3D, e);
  const sph = new THREE.Spherical(
    THREE.MathUtils.lerp(start.sph.radius, end.sph.radius, e) + Math.sin(Math.PI * e) * lift,
    THREE.MathUtils.lerp(start.sph.phi, end.sph.phi, e),
    THREE.MathUtils.lerp(start.sph.theta, end.sph.theta, e),
  );
  camera3D.position.setFromSpherical(sph).add(controls3D.target);

  controls2D.target.lerpVectors(start.target2D, end.target2D, e);
  camera2D.position.set(controls2D.target.x, camera2D.position.y, controls2D.target.z);
  camera2D.zoom = start.zoom * Math.pow(end.zoom / start.zoom, e); // Even-feeling zoom
  camera2D.updateProjectionMatrix();

  if (t >= 1) glide = null;
}

// --- ROUTE DIRECTION ARROWS ---
// Small arrows slide along the route in the walking direction, in both views.
let routeArrowTexture = null;
let routeArrowPath = null;    // { points, cumulative, total, sprites }

function getRouteArrowTexture() {
  if (routeArrowTexture) return routeArrowTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();          // A chevron pointing right; each sprite is turned to face along the route
  ctx.moveTo(22, 14);
  ctx.lineTo(42, 32);
  ctx.lineTo(22, 50);
  ctx.stroke();
  routeArrowTexture = new THREE.CanvasTexture(canvas);
  routeArrowTexture.colorSpace = THREE.SRGBColorSpace;
  return routeArrowTexture;
}

function addRouteArrows(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return;
  const spacing = Math.max(0.25, total / 28);
  const count = Math.ceil(total / spacing) + 1;
  const sprites = [];
  for (let i = 0; i < count; i++) {
    // Each arrow needs its own material because each one is turned differently.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getRouteArrowTexture(), depthTest: false, transparent: true, toneMapped: false, fog: false,
    }));
    sprite.renderOrder = 901;
    sprite.userData.isRouteLine = true;   // Sized in screen pixels by updateRouteArrows
    navGroup.add(sprite);
    sprites.push(sprite);
  }
  routeArrowPath = { points, cumulative, total, spacing, sprites };
}

const _arrowA = new THREE.Vector3();
const _arrowB = new THREE.Vector3();

function updateRouteArrows(now) {
  if (!routeArrowPath || !activeCamera) return;
  const { points, cumulative, total, spacing, sprites } = routeArrowPath;
  const offset = reducedMotion.matches ? spacing / 2 : (now * 0.00025) % spacing;
  const y = groundY + 0.03;
  const ARROW_PX = 16;
  const screenH = renderer.domElement.clientHeight;
  const halfFov = THREE.MathUtils.degToRad(camera3D.fov / 2);
  let seg = 1;
  sprites.forEach((sprite, i) => {
    const s = offset + i * spacing;
    if (s > total) {
      sprite.visible = false;
      return;
    }
    while (seg < points.length - 1 && cumulative[seg] < s) seg++;
    const a = points[seg - 1], b = points[seg];
    const len = cumulative[seg] - cumulative[seg - 1] || 1;
    const k = (s - cumulative[seg - 1]) / len;
    sprite.visible = true;
    sprite.position.set(a.x + (b.x - a.x) * k, y, a.z + (b.z - a.z) * k);
    // Keep each arrow the same size on screen at any zoom.
    let unitsPerPx;
    if (activeCamera.isOrthographicCamera) {
      unitsPerPx = (activeCamera.top - activeCamera.bottom) / activeCamera.zoom / screenH;
    } else {
      sprite.getWorldPosition(_arrowA);
      unitsPerPx = 2 * activeCamera.position.distanceTo(_arrowA) * Math.tan(halfFov) / screenH;
    }
    sprite.scale.setScalar(ARROW_PX * unitsPerPx);

    // Turn the arrow to match the route's direction as it appears on screen.
    _arrowA.set(a.x, y, a.z).applyMatrix4(navGroup.matrixWorld).project(activeCamera);
    _arrowB.set(b.x, y, b.z).applyMatrix4(navGroup.matrixWorld).project(activeCamera);
    const w = renderer.domElement.width, h = renderer.domElement.height;
    sprite.material.rotation = Math.atan2((_arrowB.y - _arrowA.y) * h, (_arrowB.x - _arrowA.x) * w);
    // Fade arrows in and out at the ends of the route.
    sprite.material.opacity = Math.min(1, s / spacing, (total - s) / spacing);
  });
}

// --- LABEL DECLUTTERING ---
// When labels would overlap, the nearer (bigger) one stays and the others fade out.
// Search hides labels with .visible; this uses opacity, so the two never fight.
const _labelPos = new THREE.Vector3();
let declutterFrame = 0;

function declutterLabels() {
  if (!activeCamera || !pubgLabelsGroup.children.length) return;
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;

  if (declutterFrame++ % 4 === 0) {
    let pxPerUnit;
    if (activeCamera.isOrthographicCamera) {
      pxPerUnit = h * activeCamera.zoom / (activeCamera.top - activeCamera.bottom);
    }
    const halfFov = THREE.MathUtils.degToRad(camera3D.fov / 2);
    const candidates = [];
    pubgLabelsGroup.children.forEach(sprite => {
      if (!sprite.visible) return;
      sprite.getWorldPosition(_labelPos);
      const dist = activeCamera.position.distanceTo(_labelPos);
      _labelPos.project(activeCamera);
      if (_labelPos.z > 1 || Math.abs(_labelPos.x) > 1.2 || Math.abs(_labelPos.y) > 1.2) {
        sprite.userData.declutterShow = false;
        return;
      }
      const ppu = pxPerUnit || h / (2 * dist * Math.tan(halfFov));
      candidates.push({
        sprite, dist,
        x: (_labelPos.x + 1) / 2 * w,
        y: (1 - _labelPos.y) / 2 * h,
        hw: sprite.scale.x * ppu / 2,
        hh: sprite.scale.y * ppu / 2,
      });
    });
    candidates.sort((a, b) => a.dist - b.dist);
    const kept = [];
    candidates.forEach(c => {
      const overlaps = kept.some(k => Math.abs(k.x - c.x) < k.hw + c.hw && Math.abs(k.y - c.y) < k.hh + c.hh);
      c.sprite.userData.declutterShow = !overlaps;
      if (!overlaps) kept.push(c);
    });
  }

  pubgLabelsGroup.children.forEach(sprite => {
    const goal = sprite.userData.declutterShow === false ? 0 : 1;
    const step = reducedMotion.matches ? 1 : 0.15;
    sprite.material.opacity += THREE.MathUtils.clamp(goal - sprite.material.opacity, -step, step);
  });
}

// --- JOYSTICK VISIBILITY LOGIC ---
function updateJoystickVisibility() {
  const is3D = document.getElementById('btn-3d').classList.contains('active');
  const suggActive = suggBox.classList.contains('active');
  const joyZone = document.getElementById('joystick-zone');
  
  if (joyZone) {
    // Only show joystick if in 3D mode AND the search suggestions are closed
    if (is3D && !suggActive) {
      joyZone.style.display = 'block';
    } else {
      joyZone.style.display = 'none';
    }
  }
}

// Automatically watch the suggestions box. Whenever it opens or closes, update the joystick!
const suggObserver = new MutationObserver(() => {
  updateJoystickVisibility();
});
suggObserver.observe(suggBox, { attributes: true, attributeFilter: ['class'] });

function setMode(mode) {
  const btn2d = document.getElementById('btn-2d');
  const btn3d = document.getElementById('btn-3d');
  
  if (mode === '2d') {
    btn2d.classList.add('active');
    btn3d.classList.remove('active');
    activeCamera = camera2D;
    controls2D.enabled = true;
    controls3D.enabled = false;
  } else {
    btn3d.classList.add('active');
    btn2d.classList.remove('active');
    activeCamera = camera3D;
    controls3D.enabled = true;
    controls2D.enabled = false;
  }
  
  // Use our new smart visibility checker
  updateJoystickVisibility();
  
  if (typeof updateBuildingVisibility === 'function') updateBuildingVisibility();
}

function animate() {
  requestAnimationFrame(animate);

// --- REAL-TIME COMPASS ROTATION ---
  const compassArrow = document.getElementById('compass-arrow');
  if (compassArrow && activeCamera) {
    // Read the rotation from whichever camera is currently active
    const currentControls = activeCamera === camera3D ? controls3D : controls2D;
    const azimuth = currentControls.getAzimuthalAngle();
    
    // +180 ensures the default points downwards (South facing up)
    const deg = (azimuth * 180 / Math.PI) + 180; 
    compassArrow.style.transform = `rotate(${deg}deg)`;
  }

  const slowTime = Date.now() * 0.002; 

if (activeHighlightMeshes && activeHighlightMeshes.length > 0) {
    activeHighlightMeshes.forEach(mesh => {
      if (!mesh.userData.baseScale) {
        mesh.userData.baseScale = mesh.scale.clone();
      }
      const blockBreath = 1.0 + Math.sin(slowTime) * 0.15; 
      mesh.scale.copy(mesh.userData.baseScale).multiplyScalar(blockBreath);
      
      if (mesh.material) {
        mesh.material.emissiveIntensity = 0.4;
      }
    });
  }

  const now = performance.now();
  if (navState && navState.mode === 'active' && navFollow) {
    cancelGlide();
    followNavCamera();
  } else {
    stepGlide(now);
  }

  if(controls2D.enabled) controls2D.update();
  if(controls3D.enabled) controls3D.update();
  clampToCampus(controls2D, camera2D);
  clampToCampus(controls3D, camera3D);
  updateFog();
  
  const resizeLabels = (group) => {
    group.children.forEach(item => {
      
      if (item.userData.isSearchLine) {
        item.material.opacity = 0.25 + Math.sin(slowTime) * 0.15;
        return;
      }

      let sprite = item.type === "Sprite" ? item : item.children.find(c => c.type === "Sprite");
      if (!sprite || !sprite.userData.baseScale) return;
      
      const base = sprite.userData.baseScale;
      let factor = 1.0;
      
      if (activeCamera.isOrthographicCamera) {
        factor = Math.max(0.6, Math.min(1.8, 1 / activeCamera.zoom)); 
      } else {
        const dist = activeCamera.position.distanceTo(item.position);
        factor = Math.max(0.4, Math.min(2.5, dist * 0.0015));
      }

      if (sprite.userData.isSearchMarker) {
        const textBreath = 1.0 + Math.sin(slowTime) * 0.025; 
        factor *= textBreath;
      }

      sprite.scale.set(base.x * factor, base.y * factor, 1);
    });
  };
  
  if (pubgLabelsGroup && activeCamera) resizeLabels(pubgLabelsGroup);
  if (searchPinGroup && activeCamera) resizeLabels(searchPinGroup);
  if (navGroup && activeCamera) resizeLabels(navGroup);
  if (headingArrow && headingArrow.visible && activeCamera) {
    const size = activeCamera.isOrthographicCamera
      ? Math.max(0.6, Math.min(1.8, 1 / activeCamera.zoom))
      : Math.max(0.6, Math.min(2.5, activeCamera.position.distanceTo(controls3D.target) * 0.1));
    headingArrow.scale.setScalar(size * 1.6);
  }
  updateRouteArrows(now);
  declutterLabels();

  // A selected building gently pulses, so its shadow has to follow it.
  if (shadowsDirty || (activeCamera === camera3D && activeHighlightMeshes.length > 0)) {
    renderer.shadowMap.needsUpdate = true;
    shadowsDirty = false;
  }

  if(renderer && activeCamera) renderer.render(scene, activeCamera);
}

// --- VIRTUAL JOYSTICK LOGIC ---
let joyActive = false;
let joyOrigin = { x: 0, y: 0 };
let animationFrameId;

if(joyZone) {
  joyZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    joyActive = true;
    const rect = joyZone.getBoundingClientRect();
    joyOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    handleJoyMove(e.changedTouches[0]);
  }, { passive: false });

  joyZone.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    e.preventDefault();
    handleJoyMove(e.changedTouches[0]);
  }, { passive: false });

  joyZone.addEventListener('touchend', () => {
    joyActive = false;
    joyKnob.style.transform = `translate(0px, 0px)`;
    cancelAnimationFrame(animationFrameId);
  });
}

function handleJoyMove(touch) {
  let dx = touch.clientX - joyOrigin.x;
  let dy = touch.clientY - joyOrigin.y;
  const maxDist = 24; 
  
  const dist = Math.hypot(dx, dy);
  if (dist > maxDist) {
    dx = (dx / dist) * maxDist;
    dy = (dy / dist) * maxDist;
  }
  
  joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  
  cancelAnimationFrame(animationFrameId);
  function applyRotation() {
    if (!joyActive || !controls3D.enabled) return;
    
    const offset = new THREE.Vector3().copy(camera3D.position).sub(controls3D.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    
    sph.theta -= dx * 0.0007; 
    sph.phi -= dy * 0.0007;   
    sph.phi = Math.max(0.1, Math.min(Math.PI * 0.45, sph.phi));
    
    camera3D.position.setFromSpherical(sph).add(controls3D.target);
    controls3D.update();
    
    animationFrameId = requestAnimationFrame(applyRotation);
  }
  applyRotation();
}

// --- DIRECTIONS ---
const REROUTE_METRES = 30;     // Further than this off the route triggers a new route
const SNAP_METRES = 25;        // Within this of a path, the GPS dot sits on the path
const ARRIVED_METRES = 20;
const WEAK_GPS_METRES = 60;
const LONG_LEG_METRES = 40;    // Off-path legs longer than this get a note to the user
const DETOUR_RATIO = 2.5;      // Routes this much longer than a straight line get a note too

const navPanel = document.getElementById('nav-panel');
const navFrom = document.getElementById('nav-from');
const navSuggestions = document.getElementById('nav-suggestions');
const btnNavGps = document.getElementById('btn-nav-gps');
const navStatus = document.getElementById('nav-status');
const navSummary = document.getElementById('nav-summary');
const navGateLink = document.getElementById('nav-gate-link');

function initNavigation(calibData) {
  if (calibData && calibData.calibration && calibData.calibration.points) {
    geo = createGeoTransform(calibData.calibration.points);
  }

  fetch('data/paths.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(`paths.json returned ${r.status}`); return r.json(); })
    .then(data => {
      walkData = data;
      walkGraph = buildGraph(data);
      walkLandmarks = mapData
        .filter(l => l._assignment_type === '2d_coords' && l.coordinates && !Array.isArray(l.coordinates))
        .map(l => ({ name: l.display_name, x: l.coordinates.x, z: l.coordinates.y }));
      if (selectedLocation) document.getElementById('btn-directions').style.display = 'flex';
      const params = new URLSearchParams(location.search);
      if (params.get('edit') === 'paths') {
        startPathEditor();
        return;
      }
      if (params.get('from')) applyQrStart(params.get('from'));
      openSharedLink(params);
    })
    .catch(err => {
      // The map still works without directions, so don't block the app.
      console.error('Directions unavailable:', err);
      openSharedLink(new URLSearchParams(location.search));
    });
}

// Every place a location appears, in the same coordinates as the walkways.
function getLocationPoints(loc) {
  worldGroup.updateMatrixWorld();
  if (loc._assignment_type === '2d_coords') {
    const coords = Array.isArray(loc.coordinates) ? loc.coordinates : [loc.coordinates];
    return coords.filter(Boolean).map(c => ({ x: c.x, z: c.y }));
  }
  const names = Array.isArray(loc.glb_objects) ? loc.glb_objects : [loc.glb_objects];
  return names.map(name => buildingMeshesMap.get(name)).filter(Boolean).map(mesh => {
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    worldGroup.worldToLocal(center);
    return { x: center.x, z: center.z };
  });
}

function closestPoint(points, target) {
  return points.reduce((best, p) =>
    (!best || Math.hypot(p.x - target.x, p.z - target.z) < Math.hypot(best.x - target.x, best.z - target.z)) ? p : best, null);
}

function startDirections(loc) {
  navState = { dest: loc, watchId: null, route: null, fromGps: false };
  document.getElementById('search-container').style.display = 'none';
  navPanel.classList.add('active');
  document.getElementById('nav-to').textContent = loc.display_name;
  navFrom.value = '';
  bottomSheet.classList.add('nav-active');
  bottomSheet.classList.remove('collapsed');
  document.getElementById('nav-floor').textContent = floorInstruction(loc.description);
  document.getElementById('nav-note').textContent = '';
  navSummary.textContent = '';
  clearSteps();
  setNavStatus('');
  document.getElementById('qr-banner').classList.remove('active');
  if (qrStartLocation) {
    chooseStartLocation(qrStartLocation);
  } else if (geo) {
    startCompass();
    startGpsTracking();
  } else {
    setNavStatus('Choose a starting point above.');
  }
}

function stopNavigation() {
  if (navState) {
    if (navState.watchId !== null) navigator.geolocation.clearWatch(navState.watchId);
    navState = null;
  }
  stopCompass();
  clearRouteLines();
  clearNavMarkers();
  navPanel.classList.remove('active');
  navSuggestions.classList.remove('active');
  btnNavGps.classList.remove('tracking');
  navGateLink.style.display = 'none';
  bottomSheet.classList.remove('nav-active');
  document.getElementById('btn-nav-start').style.display = 'none';
  leaveNavMode();
  document.getElementById('search-container').style.display = '';
}

function setNavStatus(text, isWarning = false) {
  navStatus.textContent = text;
  navStatus.classList.toggle('warning', isWarning);
  document.getElementById('banner-status').textContent = isWarning ? text : '';
}

// --- ROUTE DRAWING ---
function clearGroupChildren(match) {
  navGroup.children.filter(match).forEach(child => {
    navGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });
}

function clearRouteLines() {
  clearGroupChildren(c => c.userData.isRouteLine);
  routeArrowPath = null;
}
function clearNavMarkers() { clearGroupChildren(c => c.userData.isNavMarker); }

// width is in screen pixels. A wide, faint copy under the route gives it a glow.
function addRouteLine(points, color, dashed, { width = dashed ? 3 : 5, opacity = 1, renderOrder = 900 } = {}) {
  const positions = [];
  const y = groundY + 0.02;
  points.forEach(p => positions.push(p.x, y, p.z));

  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color,
    linewidth: width * renderer.getPixelRatio(),
    dashed,
    dashSize: 0.08,
    gapSize: 0.08,
    depthTest: false,
    transparent: true,
    opacity,
    toneMapped: false,
  });
  material.resolution.set(renderer.domElement.width, renderer.domElement.height);

  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  line.userData.isRouteLine = true;
  navGroup.add(line);
}

function drawRoute(route) {
  clearRouteLines();
  const first = route.walkway[0], last = route.walkway[route.walkway.length - 1];
  addRouteLine([route.from, first], 0x8ab4f8, true);
  addRouteLine([last, route.to], 0x8ab4f8, true);
  addRouteLine(route.walkway, 0x8ab4f8, false, { width: 16, opacity: 0.3, renderOrder: 899 });
  addRouteLine(route.walkway, 0x4285f4, false, { width: 7 });
  addRouteArrows(route.walkway);
}

function setStartMarker(point, color) {
  clearNavMarkers();
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 40, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(66, 133, 244, 0.25)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 20, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.position.set(point.x, groundY + 0.05, point.z);
  sprite.renderOrder = 997;
  sprite.scale.set(0.4, 0.4, 1);
  sprite.userData.baseScale = new THREE.Vector2(0.4, 0.4);
  sprite.userData.isNavMarker = true;
  navGroup.add(sprite);
}

// Moves both cameras so the whole route is on screen.
function fitCameraToRoute(route) {
  const points = [route.from, ...route.walkway, route.to];
  const box = new THREE.Box3();
  points.forEach(p => box.expandByPoint(new THREE.Vector3(p.x, groundY, p.z).applyMatrix4(worldGroup.matrixWorld)));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);

  const viewWidth = camera2D.right - camera2D.left;
  const viewHeight = camera2D.top - camera2D.bottom;
  const offset = new THREE.Vector3().copy(camera3D.position).sub(controls3D.target);
  const sph = new THREE.Spherical().setFromVector3(offset);
  sph.radius = Math.max(4, span * 1.6);
  glideTo({
    target: center,
    sph3D: sph,
    zoom2D: Math.max(1, Math.min(8, Math.min(viewWidth, viewHeight) / (span * 1.5))),
  });
}

function routeFrom(point, { fit }) {
  navState.lastFrom = point;
  const dest = closestPoint(getLocationPoints(navState.dest), point);
  if (!dest) {
    navState.route = null;
    navSummary.textContent = '';
    clearSteps();
    setNavStatus('This location has no position on the map yet.', true);
    updateStartButton();
    return false;
  }

  const route = findRoute(walkGraph, point, dest, { avoidStairs });
  if (!route) {
    navState.route = null;
    clearRouteLines();
    navSummary.textContent = '';
    clearSteps();
    setNavStatus(avoidStairs
      ? 'No step-free route is mapped between these two places.'
      : 'No walking route found between these two places.', true);
    updateStartButton();
    return false;
  }

  navState.route = route;
  navState.steps = buildSteps(route, { geo, landmarks: walkLandmarks, destinationName: navState.dest.display_name });
  drawRoute(route);
  if (fit) fitCameraToRoute(route);
  renderSteps(navState.steps);
  showRouteSummary(route, route.length * metresPerUnit());
  showCurrentStep(route.length * metresPerUnit());
  updateStartButton();
  return true;
}

// --- TURN-BY-TURN STEPS ---
function clearSteps() {
  document.getElementById('nav-next').textContent = '';
  document.getElementById('nav-steps').innerHTML = '';
  document.getElementById('nav-steps-wrap').style.display = 'none';
}

function renderSteps(steps) {
  const list = document.getElementById('nav-steps');
  list.innerHTML = '';
  steps.forEach(step => {
    const item = document.createElement('li');
    item.textContent = step.text;
    list.appendChild(item);
  });
  document.getElementById('nav-steps-title').textContent = `Steps (${steps.length})`;
  document.getElementById('nav-steps-wrap').style.display = 'block';
}

function showCurrentStep(remainingMetres) {
  if (!navState || !navState.steps) return;
  const index = currentStepIndex(navState.steps, remainingMetres);
  document.getElementById('nav-next').textContent = navState.steps[index].text;
  document.querySelectorAll('#nav-steps li').forEach((item, i) => item.classList.toggle('current', i === index));
}

document.getElementById('nav-stepfree').addEventListener('change', e => {
  avoidStairs = e.target.checked;
  if (navState && navState.lastFrom) {
    setNavStatus('');
    routeFrom(navState.lastFrom, { fit: true });
  }
});

function updateStepFreeNote() {
  if (!avoidStairs || !navState) return;
  const note = document.getElementById('nav-note');
  note.textContent = `${note.textContent} Only stairs marked on this map are avoided, and lifts are not mapped. Check on site if your destination is upstairs.`.trim();
}

// --- COMPASS ---
// iPhones ask for permission, which has to happen during a tap.
function startCompass() {
  stopCompass();
  const listen = () => {
    if (compassListener) return;
    compassListener = (event) => {
      let heading = null;
      if (typeof event.webkitCompassHeading === 'number') heading = event.webkitCompassHeading;
      else if (event.absolute && event.alpha !== null) heading = 360 - event.alpha;
      if (heading === null) return;
      const screenAngle = (screen.orientation && screen.orientation.angle) || 0;
      compassHeading = (heading + screenAngle + 360) % 360;
      updateHeadingArrow();
    };
    window.addEventListener('deviceorientationabsolute', compassListener);
    window.addEventListener('deviceorientation', compassListener);
  };
  if (typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === 'granted') listen(); })
      .catch(err => console.warn('Compass unavailable:', err));
  } else {
    listen();
  }
}

function stopCompass() {
  if (compassListener) {
    window.removeEventListener('deviceorientationabsolute', compassListener);
    window.removeEventListener('deviceorientation', compassListener);
    compassListener = null;
  }
  compassHeading = null;
  if (headingArrow) headingArrow.visible = false;
}

function createHeadingArrow() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.42);
  shape.lineTo(0.17, 0.12);
  shape.lineTo(-0.17, 0.12);
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(Math.PI / 2); // Lay it flat, pointing along +z
  const material = new THREE.MeshBasicMaterial({ color: 0x1a73e8, side: THREE.DoubleSide, depthTest: false, transparent: true, toneMapped: false });
  const arrow = new THREE.Mesh(geometry, material);
  arrow.renderOrder = 996;
  arrow.visible = false;
  worldGroup.add(arrow);
  return arrow;
}

// Uses the phone's compass, or the direction of travel when there is no compass.
function updateHeadingArrow() {
  if (!navState || !navState.gpsFix) return;
  const heading = compassHeading !== null ? compassHeading : navState.gpsFix.travelHeading;
  if (heading === null || heading === undefined || Number.isNaN(heading)) {
    if (headingArrow) headingArrow.visible = false;
    return;
  }
  if (!headingArrow) headingArrow = createHeadingArrow();
  const { lat, lng, shown } = navState.gpsFix;
  const dir = geo.headingToLocal(lat, lng, heading);
  headingArrow.position.set(shown.x, groundY + 0.04, shown.z);
  headingArrow.rotation.y = Math.atan2(dir.x, dir.z);
  headingArrow.visible = true;
}

// --- QR STARTING POINTS (index.html?from=<location id>) ---
function applyQrStart(id) {
  const loc = mapData.find(l => l.id === id && !l.system_data && !l.is_category_node);
  const point = loc && getLocationPoints(loc)[0];
  const banner = document.getElementById('qr-banner');
  if (!point) {
    console.warn('Unknown QR starting point:', id);
    return;
  }
  qrStartLocation = loc;
  banner.textContent = `You are at ${loc.display_name}. Search for where you want to go.`;
  banner.classList.add('active');
  setStartMarker(point, '#ffffff');

  const world = new THREE.Vector3(point.x, groundY, point.z).applyMatrix4(worldGroup.matrixWorld);
  controls2D.target.copy(world);
  camera2D.position.set(world.x, camera2D.position.y, world.z);
  camera2D.zoom = FLY_ZOOM_2D;
  camera2D.updateProjectionMatrix();
}

// --- SHARING PLACES AND DROPPED PINS ---
// A shared link opens the map on that place, with Directions ready:
//   ?place=<id>        a named place, e.g. ?place=lib
//   ?pin=<lat>,<lng>   any spot someone pinned
// Both work with ?from=<id> too, so a QR start and a destination can travel in one link.
const PIN_ID = 'dropped-pin';
const PIN_NEARBY_METRES = 120;

function nearestLandmarkName(point) {
  let best = null, bestDist = Infinity;
  walkLandmarks.forEach(l => {
    const d = Math.hypot(l.x - point.x, l.z - point.z);
    if (d < bestDist) { bestDist = d; best = l; }
  });
  return best && bestDist * metresPerUnit() <= PIN_NEARBY_METRES ? best.name : '';
}

function formatGps(gps, digits = 6) {
  return `${gps.lat.toFixed(digits)},${gps.lng.toFixed(digits)}`;
}

// A dropped pin behaves like any other place: it gets the card, Directions and Share.
function makePinLocation(point) {
  const gps = geo ? geo.localToGps(point.x, point.z) : null;
  const near = nearestLandmarkName(point);
  return {
    id: PIN_ID,
    isPin: true,
    display_name: 'Dropped pin',
    description: gps ? formatGps(gps, 5).replace(',', ', ') : 'A spot you picked on the map',
    cat_lvl_1: 'Dropped pin',
    nearby_1: near ? `Near ${near}` : '',
    _assignment_type: '2d_coords',
    coordinates: { x: point.x, y: point.z },
  };
}

function groundPointAt(clientX, clientY) {
  if (!activeCamera) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, activeCamera);
  const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY), new THREE.Vector3());
  if (!hit) return null;
  worldGroup.updateMatrixWorld();
  return worldGroup.worldToLocal(hit);
}

function dropPinAt(clientX, clientY) {
  const editingPaths = new URLSearchParams(location.search).get('edit') === 'paths';
  if (!mapData || editingPaths || (navState && navState.mode === 'active')) return;
  const point = groundPointAt(clientX, clientY);
  if (!point || !worldBox) return;
  const world = new THREE.Vector3(point.x, groundY, point.z).applyMatrix4(worldGroup.matrixWorld);
  if (!worldBox.containsPoint(world.setY((worldBox.min.y + worldBox.max.y) / 2))) {
    toast('Pins can only go on the campus.');
    return;
  }
  if (navigator.vibrate) navigator.vibrate(30);
  selectLocation(makePinLocation(point));
}

// Long-press (touch or mouse held still) or right-click drops a pin.
const LONG_PRESS_MS = 550;
const PRESS_SLOP_PX = 10;
let press = null;
let lastPinAt = 0;
let rightDown = null;
const activePointers = new Set();

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

const mapCanvas = document.getElementById('map-canvas');
mapCanvas.addEventListener('pointerdown', e => {
  activePointers.add(e.pointerId);
  if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY };
  cancelPress();
  if (activePointers.size > 1 || e.button !== 0) return;   // Pinching or right button: not a long-press
  press = {
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      const { x, y } = press;
      press = null;
      lastPinAt = performance.now();
      dropPinAt(x, y);
    }, LONG_PRESS_MS),
  };
});
mapCanvas.addEventListener('pointermove', e => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP_PX) cancelPress();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(type => mapCanvas.addEventListener(type, e => {
  activePointers.delete(e.pointerId);
  cancelPress();
}));
mapCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  // A long-press on a phone also fires this; the pin is already down.
  if (performance.now() - lastPinAt < 1000) return;
  // Right-dragging pans the map; only a right-click that stayed put drops a pin.
  if (rightDown && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > PRESS_SLOP_PX) return;
  dropPinAt(e.clientX, e.clientY);
});

// Named places link to their page under p/, which shows a preview picture in chat apps
// and then opens the map (tools/build_share_pages.py makes those pages).
const SHAREABLE_ID = /^[A-Za-z0-9_-]+$/;   // Must match SAFE_ID in tools/build_share_pages.py

function shareLinkFor(loc) {
  const base = new URL('./', location.href);   // The map's folder, e.g. /campus-map/
  if (loc.isPin) {
    const p = getLocationPoints(loc)[0];
    base.searchParams.set('pin', formatGps(geo.localToGps(p.x, p.z)));
    return base.toString();
  }
  if (SHAREABLE_ID.test(loc.id)) return new URL(`p/${loc.id}/`, base).toString();
  base.searchParams.set('place', loc.id);
  return base.toString();
}

async function shareSelected() {
  const loc = selectedLocation;
  if (!loc || (loc.isPin && !geo)) return;
  const url = shareLinkFor(loc);
  const point = getLocationPoints(loc)[0];
  const gps = point && geo ? geo.localToGps(point.x, point.z) : null;
  const title = loc.isPin ? 'A spot on the IFHE campus' : `${loc.display_name}, IFHE campus`;
  const lines = [`${title}. Open it on Campus Connect for walking directions:`, url];
  // People still off campus can use Google Maps to get to the spot.
  if (gps) lines.push(`Google Maps: https://www.google.com/maps/search/?api=1&query=${formatGps(gps)}`);

  if (navigator.share) {
    try {
      await navigator.share({ title, text: [lines[0], ...lines.slice(2)].join('\n'), url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;   // They closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Link copied. Paste it in any chat to share.');
  } catch (err) {
    toast('Couldn\'t copy the link. Copy it from the address bar instead.');
    history.replaceState(null, '', url);
  }
}

document.getElementById('btn-share').addEventListener('click', shareSelected);

function openSharedLink(params) {
  if (params.get('view') === '3d') setMode('3d');   // ?view=3d opens the map in 3D
  const placeId = params.get('place');
  const pin = params.get('pin');
  if (placeId) {
    const loc = mapData.find(l => l.id === placeId && !l.system_data && !l.is_category_node);
    if (loc) selectLocation(loc);
    else toast('That shared place is no longer on the map.');
  } else if (pin) {
    const [lat, lng] = pin.split(',').map(Number);
    if (!geo || !Number.isFinite(lat) || !Number.isFinite(lng) || !geo.isInside(lat, lng)) {
      toast('That pinned spot isn\'t on the campus map.');
      return;
    }
    selectLocation(makePinLocation(geo.gpsToLocal(lat, lng)));
  }
}

function metresPerUnit() {
  return geo ? geo.metresPerUnit : 37.9;
}

function showRouteSummary(route, metres) {
  const time = document.createElement('span');
  time.className = 'summary-time';
  time.textContent = `${walkingMinutes(metres)} min `;
  const distance = document.createElement('span');
  distance.className = 'summary-distance';
  distance.textContent = `(${formatDistance(metres)}) walk`;
  navSummary.replaceChildren(time, distance);
  const mpu = metresPerUnit();
  const startLeg = polylineLength([route.from, route.walkway[0]]) * mpu;
  const endLeg = polylineLength([route.walkway[route.walkway.length - 1], route.to]) * mpu;
  const notes = [];
  if (startLeg > LONG_LEG_METRES || endLeg > LONG_LEG_METRES) notes.push('Dashed parts show the direction only, not an exact path.');
  const straight = polylineLength([route.from, route.to]) * mpu;
  if (!avoidStairs && straight > 50 && route.length * mpu > straight * DETOUR_RATIO) notes.push('A shorter footpath may exist here that is not on this map yet.');
  document.getElementById('nav-note').textContent = notes.join(' ');
  updateStepFreeNote();
}

// --- STARTING FROM A CHOSEN PLACE ---
function findStartLocations(query) {
  const terms = query.toLowerCase().trim().split(/\s+/);
  return mapData.filter(l => {
    if (l.system_data || l.is_category_node) return false;
    const text = [l.display_name, l.keywords, l.cat_lvl_1, l.cat_lvl_2, l.cat_lvl_3, l.description]
      .filter(Boolean).join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }).slice(0, 30);
}

function chooseStartLocation(loc) {
  stopGpsTracking();
  stopCompass();
  navFrom.value = loc.display_name;
  navSuggestions.classList.remove('active');
  navGateLink.style.display = 'none';
  const point = getLocationPoints(loc)[0];
  if (!point) {
    setNavStatus('That place has no position on the map yet. Choose another.', true);
    return;
  }
  setNavStatus('');
  setStartMarker(point, '#ffffff');
  routeFrom(point, { fit: true });
}

navFrom.addEventListener('input', () => {
  navSuggestions.innerHTML = '';
  const query = navFrom.value.trim();
  if (!query) { navSuggestions.classList.remove('active'); return; }
  const matches = findStartLocations(query);
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'result-item';
    empty.textContent = 'No matching places';
    empty.style.color = 'var(--text-muted)';
    navSuggestions.appendChild(empty);
  }
  matches.forEach(loc => {
    const div = document.createElement('div');
    div.className = 'result-item';
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = loc.display_name;
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    meta.textContent = [loc.cat_lvl_1, loc.cat_lvl_2].filter(Boolean).join(' | ');
    div.append(name, meta);
    div.onclick = () => chooseStartLocation(loc);
    navSuggestions.appendChild(div);
  });
  navSuggestions.classList.add('active');
});

document.addEventListener('click', e => {
  if (!e.target.closest('#nav-panel')) navSuggestions.classList.remove('active');
});

document.getElementById('btn-directions').addEventListener('click', () => {
  if (selectedLocation && walkGraph) startDirections(selectedLocation);
});
document.getElementById('btn-nav-close').addEventListener('click', stopNavigation);
btnNavGps.addEventListener('click', () => {
  if (!navState) return;
  if (!geo) { setNavStatus('Location is not available for this map.', true); return; }
  navFrom.value = '';
  navSuggestions.classList.remove('active');
  startCompass();
  startGpsTracking();
});

// --- STARTING FROM LIVE GPS ---
function startGpsTracking() {
  stopGpsTracking();
  if (!navigator.geolocation) {
    setNavStatus('This browser cannot share your location. Choose a starting point above.', true);
    return;
  }
  navState.fromGps = true;
  navState.route = null;
  navState.fitted = false;
  btnNavGps.classList.add('tracking');
  setNavStatus('Finding your location…');
  navState.watchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000,
  });
}

function stopGpsTracking() {
  if (!navState) return;
  if (navState.watchId !== null) navigator.geolocation.clearWatch(navState.watchId);
  navState.watchId = null;
  navState.fromGps = false;
  btnNavGps.classList.remove('tracking');
}

function onGpsError(err) {
  if (!navState || !navState.fromGps) return;
  if (err.code === err.PERMISSION_DENIED) {
    stopGpsTracking();
    setNavStatus('Location access is off. Choose a starting point above.', true);
  } else if (navState.route) {
    setNavStatus('Lost your location. Your last route is still shown.', true);
  } else {
    setNavStatus('Could not find your location. Move outdoors, or choose a starting point above.', true);
  }
}

function showOffCampus() {
  if (navState.mode === 'active') exitNavMode();
  navState.route = null;
  navState.gpsFix = null;
  clearRouteLines();
  clearNavMarkers();
  clearSteps();
  if (headingArrow) headingArrow.visible = false;
  navSummary.textContent = '';
  setNavStatus('You are not on campus yet. Get to the Main Gate first, or choose a starting point above.', true);
  const gate = mapData.find(l => l.id === 'mg');
  const point = gate && getLocationPoints(gate)[0];
  if (point) {
    const gps = geo.localToGps(point.x, point.z);
    navGateLink.href = `https://www.google.com/maps/dir/?api=1&destination=${gps.lat.toFixed(6)},${gps.lng.toFixed(6)}`;
    navGateLink.style.display = 'block';
  }
}

function onGpsPosition(position) {
  if (!navState || !navState.fromGps) return;
  const { latitude, longitude, accuracy, heading } = position.coords;

  if (!geo.isInside(latitude, longitude)) {
    showOffCampus();
    return;
  }
  navGateLink.style.display = 'none';

  const mpu = metresPerUnit();
  const raw = geo.gpsToLocal(latitude, longitude);

  // A rough fix would pull the route around, so wait for a better one.
  if (accuracy > WEAK_GPS_METRES && !navState.route) {
    setNavStatus('Your GPS signal is weak. Move outdoors, or choose a starting point above.', true);
    return;
  }

  const snap = snapToGraph(walkGraph, raw);
  const shown = snap && snap.distance * mpu <= SNAP_METRES ? snap.point : raw;
  setStartMarker(shown, '#4285f4');
  navState.gpsFix = { lat: latitude, lng: longitude, shown, raw, travelHeading: heading };
  updateHeadingArrow();

  const line = navState.route ? [navState.route.from, ...navState.route.walkway, navState.route.to] : null;
  const progress = line ? progressAlong(line, raw) : null;

  if (!line || (progress.distance * mpu > REROUTE_METRES && accuracy <= WEAK_GPS_METRES)) {
    const rerouting = Boolean(line) && navState.mode === 'active';
    if (!routeFrom(raw, { fit: !navState.fitted && navState.mode !== 'active' })) return;
    navState.fitted = true;
    setNavStatus(accuracy > WEAK_GPS_METRES ? 'Your GPS signal is weak, so your position may be off.' : '', accuracy > WEAK_GPS_METRES);
    if (navState.mode === 'active') {
      if (rerouting) say('Rerouting.');
      navState.spokenKey = null;
      updateNavMode(navState.route.length * mpu);
    }
    return;
  }

  const remaining = progress.remaining * mpu;
  if (remaining <= ARRIVED_METRES) {
    navSummary.textContent = 'You have arrived';
    document.getElementById('nav-next').textContent = '';
    setNavStatus('');
    if (navState.mode === 'active') showArrived();
    return;
  }
  showRouteSummary(navState.route, remaining);
  showCurrentStep(remaining);
  if (navState.mode === 'active') updateNavMode(remaining);
  setNavStatus(accuracy > WEAK_GPS_METRES ? 'Your GPS signal is weak, so your position may be off.' : '', accuracy > WEAK_GPS_METRES);
}

// --- NAVIGATION MODE (Google Maps style) ---
// Start turns the route preview into turn-by-turn navigation: a green banner with the
// next turn, a tilted map that follows you, and spoken directions. Without GPS (a chosen
// or QR starting point) it becomes a step-by-step preview with Back and Next.
const NAV_CAMERA_DISTANCE = 2.6;    // Model units, about 100 m
const NAV_CAMERA_TILT = 0.95;       // Radians from straight down
const NAV_CAMERA_EASE = 0.12;       // How quickly the camera catches up each frame
const FIRST_STEP_METRES = 15;       // Show the first step until you have walked this far
const SAY_NOW_METRES = 25;          // Announce the turn again when this close

let navFollow = true;
let modeBeforeNav = '2d';
let voiceOn = readVoicePreference();

const MANEUVER_PATHS = {
  straight: '<path d="M12 21V4M6 10l6-6 6 6"/>',
  right: '<path d="M7 21v-8a3 3 0 0 1 3-3h9M14 5l5 5-5 5"/>',
  'slight-right': '<path d="M8 21v-6.5l9-9M10.5 5H17v6.5"/>',
  'sharp-right': '<path d="M8 21V5l9.5 9.5M17.5 7.5v7h-7"/>',
  'to-path': '<path d="M12 21V4" stroke-dasharray="2.5 3"/><path d="M6 10l6-6 6 6"/>',
  'leave-path': '<path d="M12 21V4" stroke-dasharray="2.5 3"/><path d="M6 10l6-6 6 6"/>',
};

function maneuverIcon(maneuver) {
  if (maneuver === 'arrive') {
    return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
  }
  const isLeft = maneuver.includes('left');
  const shape = MANEUVER_PATHS[maneuver.replace('left', 'right')] || MANEUVER_PATHS.straight;
  const body = isLeft ? `<g transform="matrix(-1 0 0 1 24 0)">${shape}</g>` : shape;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function readVoicePreference() {
  try {
    return localStorage.getItem('campusMapVoice') !== 'off';
  } catch (err) {
    return true;
  }
}

// Screen text says "70 m"; spoken directions read better as "70 metres".
function spoken(text) {
  return text.replace(/(\d) km\b/g, '$1 kilometres').replace(/(\d) m\b/g, '$1 metres');
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function say(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(spoken(text));
  utterance.lang = 'en-IN';
  speechSynthesis.speak(utterance);
}

function updateVoiceButton() {
  const button = document.getElementById('btn-voice');
  button.setAttribute('aria-pressed', String(voiceOn));
  button.setAttribute('aria-label', voiceOn ? 'Voice directions on' : 'Voice directions off');
  document.getElementById('icon-voice').innerHTML = voiceOn
    ? '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>'
    : '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
}

function updateStartButton() {
  const button = document.getElementById('btn-nav-start');
  const ready = navState && navState.route && navState.steps;
  button.style.display = ready ? 'flex' : 'none';
  document.getElementById('btn-nav-start-label').textContent = navState && navState.fromGps ? 'Start' : 'Preview';
}

function startNavMode() {
  if (!navState || !navState.route || !navState.steps) return;
  navState.mode = 'active';
  navState.previewIndex = 0;
  navState.spokenKey = null;
  navState.saidNow = null;
  navState.arrivedSaid = false;
  modeBeforeNav = document.getElementById('btn-3d').classList.contains('active') ? '3d' : '2d';
  document.body.classList.add('navigating');
  document.body.classList.toggle('nav-preview', !navState.fromGps);
  applyCameraOffset();
  setMode('3d');
  navFollow = true;
  document.getElementById('btn-recenter').classList.remove('visible');
  document.getElementById('banner-status').textContent = '';
  renderNavStepList();
  updateVoiceButton();
  if (navState.fromGps && navState.gpsFix) {
    const line = [navState.route.from, ...navState.route.walkway, navState.route.to];
    updateNavMode(progressAlong(line, navState.gpsFix.raw).remaining * metresPerUnit());
  } else {
    showPreviewStep(0);
  }
}

// Back to the route preview, keeping the route.
function exitNavMode() {
  if (!navState || navState.mode !== 'active') return;
  navState.mode = 'preview';
  leaveNavMode();
  if (navState.route) fitCameraToRoute(navState.route);
}

function leaveNavMode() {
  if (!document.body.classList.contains('navigating')) return;
  document.body.classList.remove('navigating', 'nav-preview');
  document.getElementById('nav-active-steps').classList.remove('open');
  document.getElementById('btn-nav-list').setAttribute('aria-expanded', 'false');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  applyCameraOffset();
  setMode(modeBeforeNav);
}

function setBanner(step, distanceText, then) {
  const extra = step.stairs ? ', using the stairs' : '';
  const banner = document.getElementById('nav-banner');
  const nextText = `${step.instruction}${extra}`;
  if (document.getElementById('banner-instruction').textContent !== nextText) {
    banner.classList.remove('swap');
    void banner.offsetWidth; // Restart the animation
    banner.classList.add('swap');
  }
  document.getElementById('banner-icon').innerHTML = maneuverIcon(step.maneuver);
  document.getElementById('banner-distance').textContent = distanceText;
  document.getElementById('banner-instruction').textContent = `${step.instruction}${extra}`;
  const thenRow = document.getElementById('banner-then');
  if (then) {
    document.getElementById('banner-then-icon').innerHTML = maneuverIcon(then.maneuver);
    document.getElementById('banner-then-text').textContent = then.instruction;
  }
  thenRow.classList.toggle('active', Boolean(then));
}

function updateEta(remainingMetres, arrived = false) {
  const minutes = walkingMinutes(remainingMetres);
  const arrival = new Date(Date.now() + minutes * 60000)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  document.getElementById('nav-eta-time').textContent = arrived ? 'Arrived' : `${minutes} min`;
  document.getElementById('nav-eta-sub').textContent = arrived
    ? navState.dest.display_name
    : `${formatDistance(remainingMetres)} · arrive ${arrival}`;
}

// Live GPS: shows the next turn and how far away it is.
function updateNavMode(remaining) {
  const steps = navState.steps;
  const walked = steps[0].remaining - remaining;
  const index = currentStepIndex(steps, remaining);
  let shownIndex, distance;
  if (walked < FIRST_STEP_METRES || index === steps.length - 1) {
    shownIndex = walked < FIRST_STEP_METRES ? 0 : index;
    const next = steps[shownIndex + 1];
    distance = remaining - (next ? next.remaining : 0);
  } else {
    shownIndex = index + 1;
    distance = remaining - steps[shownIndex].remaining;
  }
  const step = steps[shownIndex];
  const distanceText = formatDistance(Math.max(0, distance));
  setBanner(step, distanceText, steps[shownIndex + 1]);
  navState.followHeading = steps[index].heading;
  highlightNavStep(index);
  updateEta(remaining);

  // Speak each instruction once, then again as you reach the turn.
  const key = `${shownIndex}`;
  if (navState.spokenKey !== key) {
    navState.spokenKey = key;
    navState.saidNow = null;
    if (navigator.vibrate) navigator.vibrate(40);
    say(shownIndex === 0 ? `${step.instruction}, for ${distanceText}.` : `In ${distanceText}, ${lowerFirst(step.instruction)}.`);
  } else if (distance < SAY_NOW_METRES && navState.saidNow !== key && shownIndex !== 0) {
    navState.saidNow = key;
    say(`${step.instruction}.`);
  }
}

function showArrived() {
  if (navState.arrivedSaid) return;
  navState.arrivedSaid = true;
  setBanner({ maneuver: 'arrive', instruction: `You have arrived at ${navState.dest.display_name}` }, '', null);
  const floor = floorInstruction(navState.dest.description);
  document.getElementById('banner-status').textContent = floor;
  updateEta(0, true);
  say(`You have arrived at ${navState.dest.display_name}. ${floor}`);
}

// No GPS: step through the route with Back and Next.
function showPreviewStep(index) {
  const steps = navState.steps;
  navState.previewIndex = Math.max(0, Math.min(steps.length - 1, index));
  const step = steps[navState.previewIndex];
  const distanceText = step.maneuver === 'arrive' ? '' : formatDistance(step.metres);
  setBanner(step, distanceText, steps[navState.previewIndex + 1]);
  document.getElementById('banner-step-count').textContent = `${navState.previewIndex + 1} of ${steps.length}`;
  document.getElementById('btn-step-prev').disabled = navState.previewIndex === 0;
  document.getElementById('btn-step-next').disabled = navState.previewIndex === steps.length - 1;
  navState.previewTarget = { point: step.point, heading: step.heading };
  highlightNavStep(navState.previewIndex);
  updateEta(step.remaining);
  navFollow = true;
  document.getElementById('btn-recenter').classList.remove('visible');
}

function renderNavStepList() {
  const list = document.getElementById('nav-active-steps-list');
  list.innerHTML = '';
  navState.steps.forEach((step, i) => {
    const item = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'step-icon';
    icon.innerHTML = maneuverIcon(step.maneuver);
    const text = document.createElement('span');
    text.textContent = step.text;
    item.append(icon, text);
    if (!navState.fromGps) item.onclick = () => showPreviewStep(i);
    list.appendChild(item);
  });
}

function highlightNavStep(index) {
  document.querySelectorAll('#nav-active-steps-list li').forEach((item, i) => item.classList.toggle('current', i === index));
}

// Eases the tilted camera behind you, facing the way you face (or the way the route goes).
function followNavCamera() {
  let point, heading;
  if (navState.fromGps) {
    if (!navState.gpsFix) return;
    point = navState.gpsFix.shown;
    const travel = navState.gpsFix.travelHeading;
    if (compassHeading !== null) heading = compassHeading;
    else if (typeof travel === 'number' && !Number.isNaN(travel)) heading = travel;
    else heading = navState.followHeading;
  } else {
    if (!navState.previewTarget) return;
    ({ point, heading } = navState.previewTarget);
  }

  worldGroup.updateMatrixWorld();
  const target = new THREE.Vector3(point.x, groundY, point.z).applyMatrix4(worldGroup.matrixWorld);
  const offset = new THREE.Vector3().copy(camera3D.position).sub(controls3D.target);
  const sph = new THREE.Spherical().setFromVector3(offset);

  if (typeof heading === 'number') {
    const gps = geo.localToGps(point.x, point.z);
    const d = geo.headingToLocal(gps.lat, gps.lng, heading);
    const dir = new THREE.Vector3(d.x, 0, d.z).transformDirection(worldGroup.matrixWorld);
    const wantTheta = Math.atan2(-dir.x, -dir.z); // The camera sits behind you
    const turn = Math.atan2(Math.sin(wantTheta - sph.theta), Math.cos(wantTheta - sph.theta));
    sph.theta += turn * NAV_CAMERA_EASE;
  }
  sph.phi += (NAV_CAMERA_TILT - sph.phi) * NAV_CAMERA_EASE;
  sph.radius += (NAV_CAMERA_DISTANCE - sph.radius) * NAV_CAMERA_EASE;

  controls3D.target.lerp(target, NAV_CAMERA_EASE);
  camera3D.position.setFromSpherical(sph).add(controls3D.target);
}

document.getElementById('btn-nav-start').addEventListener('click', () => {
  if (navState && navState.fromGps) startCompass(); // Needs the tap for iPhone permission
  startNavMode();
});
document.getElementById('btn-nav-exit').addEventListener('click', exitNavMode);
document.getElementById('btn-step-prev').addEventListener('click', () => showPreviewStep(navState.previewIndex - 1));
document.getElementById('btn-step-next').addEventListener('click', () => showPreviewStep(navState.previewIndex + 1));
document.getElementById('btn-recenter').addEventListener('click', () => {
  navFollow = true;
  document.getElementById('btn-recenter').classList.remove('visible');
});
document.getElementById('btn-voice').addEventListener('click', () => {
  voiceOn = !voiceOn;
  try {
    localStorage.setItem('campusMapVoice', voiceOn ? 'on' : 'off');
  } catch (err) {
    // Private browsing can block storage; the setting still applies for this visit.
  }
  if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  updateVoiceButton();
});
document.getElementById('btn-nav-list').addEventListener('click', () => {
  const panel = document.getElementById('nav-active-steps');
  const open = panel.classList.toggle('open');
  document.getElementById('btn-nav-list').setAttribute('aria-expanded', String(open));
});
document.getElementById('nav-eta').addEventListener('click', () => document.getElementById('btn-nav-list').click());

// --- PATH EDITOR (index.html?edit=paths) ---
function startPathEditor() {
  const NODE_TAP_PX = 16;
  const EDGE_TAP_PX = 12;
  const canvas = renderer.domElement;
  const history = [];
  let data = { attribution: walkData.attribution, nodes: { ...walkData.nodes }, edges: walkData.edges.map(e => [...e]) };
  let selected = null;
  let nextId = Object.keys(data.nodes).reduce((max, id) => Math.max(max, parseInt(id.slice(1), 10) || 0), 0) + 1;
  let linesObj = null, pointsObj = null, selectedObj = null;

  document.getElementById('path-editor').classList.add('active');
  document.getElementById('search-container').style.display = 'none';

  let stairsMode = false;
  let stairsObj = null;

  const snapshot = () => history.push(JSON.stringify({ data, selected }));

  function redraw() {
    [linesObj, pointsObj, selectedObj, stairsObj].forEach(o => {
      if (o) { worldGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
    });
    const y = groundY + 0.02;
    const linePositions = [];
    const stairPositions = [];
    data.edges.forEach(([a, b, attrs]) => {
      const pa = data.nodes[a], pb = data.nodes[b];
      if (pa && pb) (attrs && attrs.stairs ? stairPositions : linePositions).push(pa.x, y, pa.z, pb.x, y, pb.z);
    });
    const stairGeom = new THREE.BufferGeometry();
    stairGeom.setAttribute('position', new THREE.Float32BufferAttribute(stairPositions, 3));
    stairsObj = new THREE.LineSegments(stairGeom, new THREE.LineBasicMaterial({ color: 0xff1744, depthTest: false, transparent: true }));
    stairsObj.renderOrder = 900;
    worldGroup.add(stairsObj);

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    linesObj = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0xffd54f, depthTest: false, transparent: true }));
    linesObj.renderOrder = 900;

    const pointPositions = Object.values(data.nodes).flatMap(p => [p.x, y, p.z]);
    const pointGeom = new THREE.BufferGeometry();
    pointGeom.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
    pointsObj = new THREE.Points(pointGeom, new THREE.PointsMaterial({ color: 0xff7043, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
    pointsObj.renderOrder = 901;

    const selGeom = new THREE.BufferGeometry();
    const sel = selected && data.nodes[selected];
    selGeom.setAttribute('position', new THREE.Float32BufferAttribute(sel ? [sel.x, y, sel.z] : [], 3));
    selectedObj = new THREE.Points(selGeom, new THREE.PointsMaterial({ color: 0x00e5ff, size: 12, sizeAttenuation: false, depthTest: false, transparent: true }));
    selectedObj.renderOrder = 902;

    worldGroup.add(linesObj, pointsObj, selectedObj);
  }

  function toScreen(point) {
    const v = new THREE.Vector3(point.x, groundY, point.z).applyMatrix4(worldGroup.matrixWorld).project(activeCamera);
    const rect = canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
  }

  function tapToLocal(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, activeCamera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY), new THREE.Vector3());
    return hit ? worldGroup.worldToLocal(hit) : null;
  }

  function addEdge(a, b) {
    if (a === b) return;
    if (!data.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) {
      data.edges.push(stairsMode ? [a, b, { stairs: true }] : [a, b]);
    }
  }

  function handleTap(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const tap = { x: clientX - rect.left, y: clientY - rect.top };

    let nearNode = null, nearNodeDist = NODE_TAP_PX;
    Object.entries(data.nodes).forEach(([id, p]) => {
      const s = toScreen(p);
      const d = Math.hypot(s.x - tap.x, s.y - tap.y);
      if (d < nearNodeDist) { nearNode = id; nearNodeDist = d; }
    });

    snapshot();

    if (nearNode) {
      if (selected) addEdge(selected, nearNode);
      selected = nearNode;
      redraw();
      return;
    }

    // Tapping along a path splits it, so a new path can join it there.
    let nearEdge = null, nearEdgeDist = EDGE_TAP_PX, nearT = 0;
    data.edges.forEach((edge, index) => {
      const a = toScreen(data.nodes[edge[0]]), b = toScreen(data.nodes[edge[1]]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return;
      const t = Math.max(0, Math.min(1, ((tap.x - a.x) * dx + (tap.y - a.y) * dy) / lenSq));
      const d = Math.hypot(a.x + dx * t - tap.x, a.y + dy * t - tap.y);
      if (d < nearEdgeDist) { nearEdge = index; nearEdgeDist = d; nearT = t; }
    });

    // In stairs mode with nothing selected, tapping a path marks or unmarks it.
    if (nearEdge !== null && stairsMode && !selected) {
      const [a, b, attrs] = data.edges[nearEdge];
      data.edges[nearEdge] = attrs && attrs.stairs ? [a, b] : [a, b, { stairs: true }];
      redraw();
      return;
    }

    const id = `n${nextId++}`;
    if (nearEdge !== null) {
      const [a, b, attrs] = data.edges[nearEdge];
      const pa = data.nodes[a], pb = data.nodes[b];
      data.nodes[id] = {
        x: Number((pa.x + (pb.x - pa.x) * nearT).toFixed(4)),
        z: Number((pa.z + (pb.z - pa.z) * nearT).toFixed(4)),
      };
      data.edges.splice(nearEdge, 1, ...(attrs ? [[a, id, attrs], [id, b, attrs]] : [[a, id], [id, b]]));
    } else {
      const local = tapToLocal(clientX, clientY);
      if (!local) { history.pop(); return; }
      data.nodes[id] = { x: Number(local.x.toFixed(4)), z: Number(local.z.toFixed(4)) };
    }
    if (selected) addEdge(selected, id);
    selected = id;
    redraw();
  }

  let down = null;
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', e => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) handleTap(e.clientX, e.clientY);
    down = null;
  });

  document.getElementById('btn-edit-new').onclick = () => { selected = null; redraw(); };
  document.getElementById('btn-edit-stairs').onclick = (e) => {
    stairsMode = !stairsMode;
    e.target.textContent = `Stairs: ${stairsMode ? 'on' : 'off'}`;
    e.target.setAttribute('aria-pressed', String(stairsMode));
  };
  document.getElementById('btn-edit-undo').onclick = () => {
    if (history.length === 0) return;
    ({ data, selected } = JSON.parse(history.pop()));
    redraw();
  };
  document.getElementById('btn-edit-delete').onclick = () => {
    if (!selected) return;
    snapshot();
    delete data.nodes[selected];
    data.edges = data.edges.filter(([a, b]) => a !== selected && b !== selected);
    selected = null;
    redraw();
  };
  document.getElementById('btn-edit-download').onclick = () => {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'paths.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  redraw();
}

// --- APP SHELL: loading, errors, consent, offline, install, about, tour ---
const GA_ID = 'G-6E1FY0L6WM';
const CONSENT_KEY = 'campusMapConsent';
const TOUR_KEY = 'campusMapTourSeen';
const MIN_SPLASH_MS = 1500;    // Long enough to read the club name, short enough not to annoy
const pageStartedAt = performance.now();

// Module scripts can run after DOMContentLoaded on browsers that need the
// import-map polyfill, so start either way.
function onDocumentReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null; // Private browsing or blocked storage: behave as a first visit
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Storage blocked: the choice still applies until the page closes.
  }
}

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
  } catch (err) {
    return false;
  }
}

// --- LOADING AND ERRORS ---
function setLoadProgress(fraction, text) {
  const bar = document.getElementById('loading-progress-bar');
  const track = document.getElementById('loading-progress');
  if (!bar || !track) return;
  const clamped = Math.max(0.04, Math.min(1, fraction));
  bar.style.transform = `scaleX(${clamped})`;
  track.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
  if (text) document.getElementById('loading-status').textContent = text;
}

function hideLoadingScreen() {
  const wait = Math.max(0, MIN_SPLASH_MS - (performance.now() - pageStartedAt));
  setTimeout(() => {
    const loader = document.getElementById('loading-screen');
    if (!loader) return;
    loader.style.opacity = '0';
    loader.style.visibility = 'hidden';
    setTimeout(() => loader.remove(), 600);
  }, wait);
}

function showFatalError(title, message) {
  document.getElementById('fatal-title').textContent = title;
  document.getElementById('fatal-message').textContent = message;
  document.getElementById('fatal-error').hidden = false;
  const loader = document.getElementById('loading-screen');
  if (loader) loader.remove();
}

document.getElementById('btn-fatal-retry').addEventListener('click', () => location.reload());

// --- TOASTS ---
function toast(message, { action, onAction, duration = 4500 } = {}) {
  const region = document.getElementById('toast-region');
  const item = document.createElement('div');
  item.className = 'toast';
  item.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  item.appendChild(text);
  const close = () => {
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 260);
  };
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action;
    button.addEventListener('click', () => { close(); onAction(); });
    item.appendChild(button);
  }
  region.appendChild(item);
  if (duration) setTimeout(close, duration);
  return close;
}

window.addEventListener('offline', () => toast('You are offline. The map still works; live location may be slower.'));
window.addEventListener('online', () => toast('Back online.'));

// --- ANALYTICS CONSENT (DPDP: nothing loads until the visitor says yes) ---
let analyticsLoaded = false;

function loadAnalytics() {
  window[`ga-disable-${GA_ID}`] = false;
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
}

function clearAnalyticsCookies() {
  const hosts = [location.hostname, `.${location.hostname.split('.').slice(-2).join('.')}`];
  document.cookie.split(';').forEach(cookie => {
    const name = cookie.split('=')[0].trim();
    if (!name.startsWith('_ga')) return;
    hosts.forEach(host => { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${host}`; });
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
}

function setConsent(granted) {
  writeSetting(CONSENT_KEY, granted ? 'granted' : 'denied');
  document.getElementById('toggle-analytics').checked = granted;
  if (granted) {
    loadAnalytics();
  } else {
    window[`ga-disable-${GA_ID}`] = true; // Stops an already-loaded tag from sending anything more
    clearAnalyticsCookies();
  }
}

// Resolves once the visitor has answered (or had already answered before).
function askForConsent() {
  const saved = readSetting(CONSENT_KEY);
  document.getElementById('toggle-analytics').checked = saved === 'granted';
  if (saved === 'granted') loadAnalytics();
  if (saved) return Promise.resolve();

  const banner = document.getElementById('consent-banner');
  banner.hidden = false;
  return new Promise(resolve => {
    const answer = (granted) => {
      setConsent(granted);
      banner.hidden = true;
      resolve();
    };
    document.getElementById('btn-consent-allow').addEventListener('click', () => answer(true), { once: true });
    document.getElementById('btn-consent-deny').addEventListener('click', () => answer(false), { once: true });
  });
}

document.getElementById('toggle-analytics').addEventListener('change', (e) => {
  setConsent(e.target.checked);
  toast(e.target.checked ? 'Analytics on. Thank you.' : 'Analytics off. Cookies cleared.');
});

// --- OFFLINE SUPPORT (service worker) ---
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(registration => {
    const offerUpdate = (worker) => {
      toast('A new version of the map is ready.', {
        action: 'Refresh',
        duration: 0,
        onAction: () => worker.postMessage('SKIP_WAITING'),
      });
    };
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });
  }).catch(err => console.warn('Offline support unavailable:', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// --- INSTALL AS AN APP ---
let installPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.getElementById('btn-install').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.getElementById('btn-install').hidden = true;
  toast('Installed. You can open the map from your home screen.');
});
document.getElementById('btn-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.getElementById('btn-install').hidden = true;
});

// --- ABOUT ---
const aboutDialog = document.getElementById('about-dialog');

function openAbout() {
  const places = mapData ? mapData.filter(l => !l.system_data && !l.is_category_node).length : 0;
  document.getElementById('about-place-count').textContent = places ? `${places}` : 'the';
  document.getElementById('install-ios-hint').hidden = !(isIos() && !isStandalone());
  if (typeof aboutDialog.showModal === 'function') aboutDialog.showModal();
  else aboutDialog.setAttribute('open', '');
}

function closeAbout() {
  if (typeof aboutDialog.close === 'function') aboutDialog.close();
  else aboutDialog.removeAttribute('open');
}

document.getElementById('btn-about').addEventListener('click', openAbout);
document.getElementById('btn-about-close').addEventListener('click', closeAbout);
aboutDialog.addEventListener('click', (e) => { if (e.target === aboutDialog) closeAbout(); }); // Tap outside closes
document.getElementById('btn-replay-tour').addEventListener('click', () => {
  closeAbout();
  setTimeout(startTour, 250);
});

// --- WELCOME AND GUIDED TOUR (driver.js) ---
function showWelcome() {
  const card = document.getElementById('welcome-card');
  card.hidden = false;
  document.getElementById('btn-welcome-tour').focus({ preventScroll: true });
  const done = (tour) => {
    card.hidden = true;
    writeSetting(TOUR_KEY, '1');
    if (tour) startTour();
  };
  document.getElementById('btn-welcome-tour').addEventListener('click', () => done(true), { once: true });
  document.getElementById('btn-welcome-skip').addEventListener('click', () => done(false), { once: true });
}

function startTour() {
  writeSetting(TOUR_KEY, '1');
  const tourLib = window.driver && window.driver.js && window.driver.js.driver;
  if (!tourLib) {
    toast('The tour needs an internet connection the first time. Try again once you are online.');
    return;
  }
  clearSelection();
  suggBox.classList.remove('active');
  const tour = tourLib({
    showProgress: true,
    progressText: '{{current}} of {{total}}',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    popoverClass: 'campus-tour',
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 18,
    smoothScroll: false,
    steps: [
      {
        popover: {
          title: 'Welcome to Campus Connect',
          description: 'A quick look at the main buttons. It takes about 30 seconds, and you can skip it any time.',
        },
      },
      {
        element: '#top-search',
        popover: {
          title: 'Search for a place',
          description: 'Type a classroom, hostel, office or food spot. "LT A", "laundry" and "Bru" all work.',
          side: 'bottom', align: 'center',
        },
      },
      {
        element: '#btn-show-categories',
        popover: {
          title: 'Browse instead',
          description: 'Not sure of the name? Browse food, hostels, academics, sports and more.',
          side: 'bottom', align: 'end',
        },
      },
      {
        element: '#view-toggle',
        popover: {
          title: '2D or 3D',
          description: '2D is easiest for finding your way. 3D helps you recognise buildings. Pinch to zoom and drag to look around.',
          side: 'top', align: 'center',
        },
      },
      {
        element: '#btn-compass',
        popover: {
          title: 'Compass',
          description: 'The red tip points north. Tap it to straighten the map.',
          side: 'left', align: 'center',
        },
      },
      {
        element: '#btn-about',
        popover: {
          title: 'About and settings',
          description: 'Install the map as an app, replay this tour or change your privacy choice here.',
          side: 'left', align: 'center',
        },
      },
      {
        popover: {
          title: 'Getting directions',
          description: 'Pick any place, then tap Directions. Allow location for live, spoken turn-by-turn guidance, or choose where you are starting from. To meet someone, long-press the map to drop a pin and tap Share. That\'s it.',
        },
      },
    ],
  });
  tour.drive();
}

// Called once the model and data are on screen.
function onAppReady() {
  setLoadProgress(1, 'Ready');
  hideLoadingScreen();
  registerServiceWorker();
  setTimeout(async () => {
    await askForConsent();
    // QR visitors and people opening a shared place already know where they are going; don't interrupt them.
    const params = new URLSearchParams(location.search);
    if (!readSetting(TOUR_KEY) && !['from', 'edit', 'place', 'pin'].some(key => params.get(key))) {
      showWelcome();
    }
  }, Math.max(0, MIN_SPLASH_MS - (performance.now() - pageStartedAt)) + 700);
}
