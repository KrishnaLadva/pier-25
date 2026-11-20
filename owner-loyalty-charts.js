import * as d3 from 'd3';

const CHART_PALETTE = [
  '#12261d', // Deep Forest
  '#c9a45c', // Champagne Gold
  '#284f3c', // Forest Soft
  '#9c7936', // Deep Gold
  '#4e7460', // Sage Pine
  '#7c5d32', // Roasted Espresso
];

function formatNumber(val) {
  return Math.round(Number(val || 0)).toLocaleString('en-IN');
}

function formatRupeesCompact(val) {
  const num = Math.round(Number(val || 0));
  return `₹${num.toLocaleString('en-IN')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLoyaltyTrendsChart(containerEl, trendsData, { mode = 'flow' } = {}) {
  if (!containerEl) return;
  const buckets = trendsData?.buckets || [];
  containerEl.innerHTML = '';

  if (buckets.length === 0) {
    containerEl.innerHTML = `
      <div class="d3-empty-state">
        <strong>No loyalty activity recorded yet</strong>
        <p>Signup bonuses, dine-in or online order points, and verified guest review rewards will chart here automatically.</p>
      </div>
    `;
    return;
  }

  const width = 560;
  const height = 248;
  const margin = { top: 18, right: 20, bottom: 34, left: 48 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const wrapper = document.createElement('div');
  wrapper.className = 'd3-chart-frame';
  containerEl.appendChild(wrapper);

  const tooltip = document.createElement('div');
  tooltip.className = 'd3-tooltip';
  tooltip.hidden = true;
  wrapper.appendChild(tooltip);

  const svg = d3
    .select(wrapper)
    .append('svg')
    .attr('class', 'd3-svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('role', 'img')
    .attr('aria-label', `Loyalty point ${mode === 'cumulative' ? 'cumulative growth' : 'earned and redeemed'} trend across ${buckets.length} periods`);

  const defs = svg.append('defs');
  const areaGrad = defs
    .append('linearGradient')
    .attr('id', `pier25-loyalty-grad-${mode}`)
    .attr('x1', '0%')
    .attr('y1', '0%')
    .attr('x2', '0%')
    .attr('y2', '100%');
  areaGrad.append('stop').attr('offset', '0%').attr('stop-color', '#186a3b').attr('stop-opacity', 0.24);
  areaGrad.append('stop').attr('offset', '100%').attr('stop-color', '#186a3b').attr('stop-opacity', 0.02);

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const x = d3
    .scalePoint()
    .domain(buckets.map((b) => b.key))
    .range([0, innerW])
    .padding(0.2);

  const maxPrimary =
    mode === 'cumulative'
      ? d3.max(buckets, (b) => b.cumulativeEarned) || 100
      : d3.max(buckets, (b) => Math.max(b.earned, b.redeemed)) || 100;

  const y = d3
    .scaleLinear()
    .domain([0, Math.ceil(maxPrimary * 1.15)])
    .nice(4)
    .range([innerH, 0]);

  // Subtle horizontal gridlines
  g.append('g')
    .attr('class', 'd3-grid')
    .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(''))
    .call((sel) => sel.select('.domain').remove())
    .call((sel) => sel.selectAll('line').attr('stroke', '#e6dcc9').attr('stroke-dasharray', '3,3'));

  // X Axis
  const labelByKey = new Map(buckets.map((b) => [b.key, b.label]));
  g.append('g')
    .attr('class', 'd3-axis d3-axis-x')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickFormat((k) => labelByKey.get(k) || k).tickSizeOuter(0))
    .call((sel) => sel.select('.domain').attr('stroke', '#dfd4c0'))
    .call((sel) => sel.selectAll('.tick line').attr('stroke', '#dfd4c0'))
    .call((sel) =>
      sel
        .selectAll('text')
        .attr('fill', '#526159')
        .attr('font-size', '10.5px')
        .attr('font-weight', '600')
    );

  // Y Axis
  g.append('g')
    .attr('class', 'd3-axis d3-axis-y')
    .call(
      d3
        .axisLeft(y)
        .ticks(4)
        .tickSizeOuter(0)
        .tickFormat((d) => (d >= 1000 ? `${(d / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(d)))
    )
    .call((sel) => sel.select('.domain').remove())
    .call((sel) => sel.selectAll('.tick line').remove())
    .call((sel) =>
      sel
        .selectAll('text')
        .attr('fill', '#526159')
        .attr('font-size', '10.5px')
        .style('font-variant-numeric', 'tabular-nums')
    );

  const primaryVal = (b) => (mode === 'cumulative' ? b.cumulativeEarned : b.earned);

  const areaGen = d3
    .area()
    .x((b) => x(b.key))
    .y0(innerH)
    .y1((b) => y(primaryVal(b)))
    .curve(d3.curveMonotoneX);

  const primaryLineGen = d3
    .line()
    .x((b) => x(b.key))
    .y((b) => y(primaryVal(b)))
    .curve(d3.curveMonotoneX);

  g.append('path')
    .datum(buckets)
    .attr('fill', `url(#pier25-loyalty-grad-${mode})`)
    .attr('d', areaGen);

  g.append('path')
    .datum(buckets)
    .attr('fill', 'none')
    .attr('stroke', '#12261d')
    .attr('stroke-width', 2.5)
    .attr('d', primaryLineGen);

  if (mode === 'flow') {
    const redeemedLineGen = d3
      .line()
      .x((b) => x(b.key))
      .y((b) => y(b.redeemed))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(buckets)
      .attr('fill', 'none')
      .attr('stroke', '#9c7936')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5,4')
      .attr('d', redeemedLineGen);

    g.selectAll('.dot-redeemed')
      .data(buckets)
      .join('circle')
      .attr('class', 'dot-redeemed')
      .attr('cx', (b) => x(b.key))
      .attr('cy', (b) => y(b.redeemed))
      .attr('r', 3.5)
      .attr('fill', '#faf6ee')
      .attr('stroke', '#9c7936')
      .attr('stroke-width', 2);
  }

  const crosshair = g
    .append('line')
    .attr('class', 'd3-crosshair')
    .attr('y1', 0)
    .attr('y2', innerH)
    .attr('stroke', '#c9a45c')
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', '3,3')
    .style('opacity', 0);

  g.selectAll('.dot-primary')
    .data(buckets)
    .join('circle')
    .attr('class', 'dot-primary')
    .attr('cx', (b) => x(b.key))
    .attr('cy', (b) => y(primaryVal(b)))
    .attr('r', 4.2)
    .attr('fill', '#faf6ee')
    .attr('stroke', '#12261d')
    .attr('stroke-width', 2.2);

  function showTooltip(event, b) {
    const px = x(b.key);
    const py = y(primaryVal(b));
    crosshair.attr('x1', px).attr('x2', px).style('opacity', 1);
    tooltip.hidden = false;
    tooltip.innerHTML = `
      <div class="d3-tip-title">${escapeHtml(b.rangeLabel || b.label)}</div>
      <div class="d3-tip-row"><span>Earned</span><strong class="tabular-nums">+${formatNumber(b.earned)} pts</strong></div>
      <div class="d3-tip-row"><span>Redeemed</span><strong class="tabular-nums">−${formatNumber(b.redeemed)} pts</strong></div>
      <div class="d3-tip-row"><span>Cumulative</span><strong class="tabular-nums">${formatNumber(b.cumulativeEarned)} pts</strong></div>
    `;
    const leftPct = Math.max(14, Math.min(82, ((margin.left + px) / width) * 100));
    const topPct = Math.max(10, Math.min(62, ((margin.top + py) / height) * 100));
    tooltip.style.left = `${leftPct}%`;
    tooltip.style.top = `${topPct}%`;
  }

  function hideTooltip() {
    crosshair.style('opacity', 0);
    tooltip.hidden = true;
  }

  g.selectAll('.dot-hit')
    .data(buckets)
    .join('circle')
    .attr('class', 'dot-hit')
    .attr('cx', (b) => x(b.key))
    .attr('cy', (b) => y(primaryVal(b)))
    .attr('r', 18)
    .attr('fill', 'transparent')
    .attr('tabindex', 0)
    .attr('aria-label', (b) => `${b.label}: earned ${b.earned} points, redeemed ${b.redeemed} points`)
    .style('cursor', 'pointer')
    .on('mouseenter focus', showTooltip)
    .on('mouseleave blur', hideTooltip);
}

export function renderGuestDemographicsChart(containerEl, demographicsData) {
  if (!containerEl) return;
  const segments = demographicsData?.segments || [];
  const topGuests = demographicsData?.topGuests || [];
  containerEl.innerHTML = '';

  if (segments.length === 0) {
    containerEl.innerHTML = `
      <div class="d3-empty-state">
        <strong>No customer profiles recorded yet</strong>
        <p>Guest demographics by loyalty tier, neighborhood, and taste profile will populate here once guests join.</p>
      </div>
    `;
    return;
  }

  const layout = document.createElement('div');
  layout.className = 'd3-demo-layout';
  containerEl.appendChild(layout);

  const donutWrap = document.createElement('div');
  donutWrap.className = 'd3-donut-wrap';
  layout.appendChild(donutWrap);

  const listWrap = document.createElement('div');
  listWrap.className = 'd3-demo-list';
  layout.appendChild(listWrap);

  const size = 216;
  const radius = size / 2;
  const outerR = radius - 10;
  const innerR = outerR * 0.62;

  const color = d3
    .scaleOrdinal()
    .domain(segments.map((s) => s.label))
    .range(CHART_PALETTE);

  const svg = d3
    .select(donutWrap)
    .append('svg')
    .attr('class', 'd3-donut-svg')
    .attr('viewBox', `0 0 ${size} ${size}`)
    .attr('role', 'img')
    .attr(
      'aria-label',
      `Top guest demographics donut chart grouped by ${demographicsData?.activeDimension || 'tier'}`
    );

  const g = svg.append('g').attr('transform', `translate(${radius},${radius})`);

  const pie = d3
    .pie()
    .value((d) => Math.max(1, d.totalPoints))
    .sort(null)
    .padAngle(0.03);

  const arc = d3.arc().innerRadius(innerR).outerRadius(outerR).cornerRadius(4);
  const arcHover = d3.arc().innerRadius(innerR).outerRadius(outerR + 5).cornerRadius(4);

  const centerTitle = g
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('y', -5)
    .attr('fill', '#12261d')
    .attr('font-family', "'Cormorant Garamond', Georgia, serif")
    .attr('font-size', '24px')
    .attr('font-weight', '700')
    .style('font-variant-numeric', 'tabular-nums')
    .text(`${demographicsData.totalMembers} Guests`);

  const centerSub = g
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('y', 16)
    .attr('fill', '#526159')
    .attr('font-size', '11px')
    .attr('font-weight', '600')
    .style('font-variant-numeric', 'tabular-nums')
    .text(`${formatNumber(demographicsData.totalPointsEarned)} pts`);

  const slices = g
    .selectAll('.d3-donut-slice')
    .data(pie(segments))
    .join('path')
    .attr('class', 'd3-donut-slice')
    .attr('d', arc)
    .attr('fill', (d) => color(d.data.label))
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 1.5)
    .attr('tabindex', 0)
    .attr('aria-label', (d) => `${d.data.label}: ${d.data.count} guests, ${formatNumber(d.data.totalPoints)} points`)
    .style('cursor', 'pointer')
    .style('transition', 'opacity 0.16s ease');

  const rowEls = new Map();

  function highlightSegment(label) {
    if (!label) {
      slices.attr('d', arc).style('opacity', 1);
      centerTitle.text(`${demographicsData.totalMembers} Guests`);
      centerSub.text(`${formatNumber(demographicsData.totalPointsEarned)} pts`);
      rowEls.forEach((el) => el.classList.remove('is-highlighted'));
      return;
    }
    const target = segments.find((s) => s.label === label);
    slices
      .attr('d', (d) => (d.data.label === label ? arcHover(d) : arc(d)))
      .style('opacity', (d) => (d.data.label === label ? 1 : 0.45));
    if (target) {
      centerTitle.text(`${target.pointsSharePct}% Pts`);
      centerSub.text(`${target.count} ${target.count === 1 ? 'guest' : 'guests'} · ${formatNumber(target.totalPoints)}`);
    }
    rowEls.forEach((el, k) => el.classList.toggle('is-highlighted', k === label));
  }

  slices
    .on('mouseenter focus', (_ev, d) => highlightSegment(d.data.label))
    .on('mouseleave blur', () => highlightSegment(null));

  for (const seg of segments) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'd3-demo-row';
    row.innerHTML = `
      <span class="d3-demo-swatch" style="background:${color(seg.label)}"></span>
      <span class="d3-demo-label-col">
        <strong>${escapeHtml(seg.label)}</strong>
        <small class="tabular-nums">${seg.count} ${seg.count === 1 ? 'guest' : 'guests'} (${seg.sharePct}%) · Avg ₹${formatNumber(seg.avgSpend)}</small>
      </span>
      <span class="d3-demo-metric-col">
        <strong class="tabular-nums">${formatNumber(seg.totalPoints)} pts</strong>
        <span class="d3-demo-bar-track"><span class="d3-demo-bar-fill" style="width:${Math.max(8, seg.pointsSharePct)}%;background:${color(seg.label)}"></span></span>
      </span>
    `;
    row.addEventListener('mouseenter', () => highlightSegment(seg.label));
    row.addEventListener('focus', () => highlightSegment(seg.label));
    row.addEventListener('mouseleave', () => highlightSegment(null));
    row.addEventListener('blur', () => highlightSegment(null));
    listWrap.appendChild(row);
    rowEls.set(seg.label, row);
  }

  // Top Guests Contribution D3 Horizontal Bar Strip
  if (topGuests.length > 0) {
    const barSection = document.createElement('div');
    barSection.className = 'd3-top-guests-strip';
    barSection.innerHTML = '<div class="d3-strip-head"><span>Top Loyalty Guests Contribution</span><span class="tabular-nums">Earned vs Available Balance</span></div>';
    containerEl.appendChild(barSection);

    const barW = 540;
    const rowH = 26;
    const barMargin = { top: 4, right: 68, bottom: 4, left: 174 };
    const barH = topGuests.length * rowH + barMargin.top + barMargin.bottom;
    const innerBarW = barW - barMargin.left - barMargin.right;

    const maxGuestPts = Math.max(100, d3.max(topGuests, (gItem) => gItem.totalLoyaltyEarned) || 100);
    const bx = d3.scaleLinear().domain([0, maxGuestPts]).range([0, innerBarW]);

    const barSvg = d3
      .select(barSection)
      .append('svg')
      .attr('class', 'd3-bar-svg')
      .attr('viewBox', `0 0 ${barW} ${barH}`)
      .attr('role', 'img')
      .attr('aria-label', 'Top guests ranked by total loyalty points earned and remaining balance');

    const bg = barSvg.append('g').attr('transform', `translate(${barMargin.left},${barMargin.top})`);

    const rows = bg
      .selectAll('.d3-guest-bar-row')
      .data(topGuests)
      .join('g')
      .attr('class', 'd3-guest-bar-row')
      .attr('transform', (_d, i) => `translate(0,${i * rowH})`);

    rows
      .append('text')
      .attr('x', -8)
      .attr('y', 16)
      .attr('text-anchor', 'end')
      .attr('fill', '#17231d')
      .attr('font-size', '10.5px')
      .attr('font-weight', '600')
      .text((d) => {
        const full = `${d.displayName} · ${d.neighborhood}`;
        return full.length > 27 ? `${full.slice(0, 26)}…` : full;
      });

    rows
      .append('rect')
      .attr('x', 0)
      .attr('y', 5)
      .attr('height', 14)
      .attr('width', innerBarW)
      .attr('rx', 3)
      .attr('fill', '#f2eadc');

    rows
      .append('rect')
      .attr('x', 0)
      .attr('y', 5)
      .attr('height', 14)
      .attr('width', (d) => Math.max(4, bx(d.totalLoyaltyEarned)))
      .attr('rx', 3)
      .attr('fill', '#c9a45c');

    rows
      .append('rect')
      .attr('x', 0)
      .attr('y', 5)
      .attr('height', 14)
      .attr('width', (d) => Math.max(2, bx(d.loyaltyPoints)))
      .attr('rx', 3)
      .attr('fill', '#12261d');

    rows
      .append('text')
      .attr('x', innerBarW + 8)
      .attr('y', 16)
      .attr('fill', '#12261d')
      .attr('font-size', '11px')
      .attr('font-weight', '700')
      .style('font-variant-numeric', 'tabular-nums')
      .text((d) => `${formatNumber(d.totalLoyaltyEarned)} pts`);
  }
}

export { formatRupeesCompact };
