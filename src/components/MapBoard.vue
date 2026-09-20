<template>
  <div class="map-wrap">
    <!-- 地图容器 -->
    <div ref="mapRef" class="map-container"></div>

    <!-- 地图加载状态 -->
    <div v-if="loading" class="map-loading">
      <span class="spinner"></span>
      <p>{{ loadError ? '地图加载失败，请检查 VITE_AMAP_KEY' : '正在加载高德地图…' }}</p>
      <p v-if="loadError" class="err">{{ loadError }}</p>
    </div>

    <!-- 图例 -->
    <div class="legend">
      <div class="legend-title">图例</div>
      <div class="legend-item"><i class="dot" style="background:#ef5350"></i>Ⅰ级·特大</div>
      <div class="legend-item"><i class="dot" style="background:#ff9800"></i>Ⅱ级·重大</div>
      <div class="legend-item"><i class="dot" style="background:#ffc107"></i>Ⅲ级·较大</div>
      <div class="legend-item"><i class="dot" style="background:#4caf50"></i>Ⅳ级·一般</div>
      <div class="legend-item"><i class="dot" style="background:#2962ff"></i>资源库/救援点</div>
      <div class="legend-item"><i class="dot" style="background:#26a69a"></i>安置点/转移路线</div>
      <div class="legend-item"><i class="dot" style="background:#ef5350"></i>道路阻断（红待确认/橙封路）</div>
      <div class="legend-item"><i class="dot" style="background:#ffc107"></i>绕行/改派路线</div>
    </div>

    <!-- 勾绘提示条 -->
    <div v-if="rbStore.drawing" class="draw-tip">
      🚧 正在勾绘封闭范围：依次点击地图加点
      <button @click="finishDraw">✅ 完成</button>
      <button @click="cancelDraw">取消</button>
    </div>

    <!-- 事件选中浮层（右下角信息卡） -->
    <div v-if="selectedEvent" class="event-pop">
      <div class="pop-head" :style="{ borderColor: severityColor(selectedEvent.severity) }">
        <span class="pop-type" :style="{ background: eventColor(selectedEvent.type) }">{{ typeLabel(selectedEvent.type) }}</span>
        <strong>{{ selectedEvent.title }}</strong>
        <span class="pop-sev" :style="{ color: severityColor(selectedEvent.severity) }">{{ severityLabel(selectedEvent.severity) }}</span>
      </div>
      <p class="pop-desc">{{ selectedEvent.desc }}</p>
      <div class="pop-meta">
        <span>📍 {{ selectedEvent.location?.name }}</span>
        <span>👥 影响 {{ (selectedEvent.affected || 0).toLocaleString() }} 人</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore, BLOCKAGE_STATUS } from '@/store/roadblock'
import { loadAMap } from '@/config/amap'
import { EVENT_TYPES, SEVERITY } from '@/mock/data'

const store = useCommandStore()
const transfer = useTransferStore()
const rbStore = useRoadblockStore()
const mapRef = ref(null)
const loading = ref(true)
const loadError = ref('')

let map = null
let amap = null
let heatmap = null
let overlays = {
  poly: [], markers: [], lines: [], baseMarkers: [], shelterMarkers: [], transferLines: [],
  blockageShapes: [], draftShapes: []
}

const selectedEvent = computed(() =>
  store.events.find((e) => e.id === store.selectedEventId) || null
)

const typeLabel = (t) => EVENT_TYPES[t]?.label || t
const eventColor = (t) => EVENT_TYPES[t]?.color || '#777'
const severityColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const severityLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s

// 事件 Marker 内容
function eventMarkerContent(ev) {
  const color = eventColor(ev.type)
  return `
    <div class="ev-marker" style="--c:${color}" title="${ev.title}">
      <span class="ev-icon">${EVENT_TYPES[ev.type]?.icon}</span>
      <span class="ev-pulse"></span>
    </div>`
}

function baseMarkerContent(base) {
  return `
    <div class="base-marker" title="${base.name}">
      <i></i><span>🏗️</span>
    </div>`
}

// 渲染受灾范围 + 事件 Marker + 资源库
function renderEvents() {
  clearEvents()
  store.filteredEvents.forEach((ev) => {
    // Polygon 受灾范围
    if (amap && ev.affectedPolygon) {
      const poly = new amap.Polygon({
        path: ev.affectedPolygon,
        fillColor: eventColor(ev.type),
        fillOpacity: ev.status === 'closed' ? 0.12 : 0.28,
        strokeColor: eventColor(ev.type),
        strokeWeight: 2,
        strokeOpacity: 0.9,
        bubble: true
      })
      poly.on('click', () => store.selectEvent(ev.id))
      map.add(poly)
      overlays.poly.push(poly)
    }
    // 事件 Marker（气泡会转发点击）
    if (amap) {
      const marker = new amap.Marker({
        position: [ev.location?.lng, ev.location?.lat],
        content: eventMarkerContent(ev),
        anchor: 'center',
        offset: [0, -10],
        cursor: 'pointer'
      })
      marker.on('click', () => store.selectEvent(ev.id))
      map.add(marker)
      overlays.markers.push(marker)
    }
  })
  // 资源库 Marker
  store.bases.forEach((base) => {
    if (!amap) return
    const marker = new amap.Marker({
      position: [base.lng, base.lat],
      content: baseMarkerContent(base),
      anchor: 'center',
      cursor: 'pointer'
    })
    marker.on('click', () => {
      store.selectedEventId = null
      map.setFitView([marker], false, [100, 100, 120, 100])
    })
    map.add(marker)
    overlays.baseMarkers.push(marker)
  })
}

function clearEvents() {
  overlays.markers.forEach((m) => map?.remove(m))
  overlays.poly.forEach((p) => map?.remove(p))
  overlays.baseMarkers.forEach((m) => map?.remove(m))
  overlays.markers = []
  overlays.poly = []
  overlays.baseMarkers = []
}

// 热力图层（汇总所有受灾范围质心模拟人口密度）
function renderHeatmap() {
  const points = []
  store.filteredEvents.forEach((ev) => {
    if (!ev.heatRadius) return
    const rings = ev.heatRadius
    for (let k = 0; k < 60; k++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * rings
      const dLng = (r * Math.cos(a)) / (111.32 * Math.cos((ev.location.lat * Math.PI) / 180))
      const dLat = (r * Math.sin(a)) / 111.32
      points.push({ lng: ev.location.lng + dLng, lat: ev.location.lat + dLat, count: 1 })
    }
  })
  if (!points.length) return
  // Heatmap 插件需通过 map.plugin 异步就绪后再创建
  if (map && !heatmap) {
    try {
      map.plugin(['AMap.Heatmap'], () => {
        const HeatmapCtor = amap.HeatMap || amap.Heatmap
        heatmap = new HeatmapCtor(map, {
          radius: 40,
          gradient: {
            0.2: '#2f9cf5', 0.4: '#4caf50', 0.6: '#ffc107',
            0.8: '#ff9800', 1.0: '#ef5350'
          },
          opacity: [0, 0.6]
        })
        heatmap.setDataSet({ data: points, max: 10 })
      })
    } catch (e) {
      console.warn('热力图层加载失败（不影响主流程）', e)
    }
  } else if (heatmap) {
    heatmap.setDataSet({ data: points, max: 10 })
  }
}

// 渲染派发路径线（资源库 → 受灾点/安置点；阻断后按绕行点/挂起状态着色）
function renderDispatches() {
  clearLines()
  store.dispatches.forEach((d) => {
    const base = store.bases.find((b) => b.id === d.baseId)
    if (!base) return
    const path = (d.routePoints && d.routePoints.length >= 2)
      ? d.routePoints.map((p) => [p[0], p[1]])
      : [[base.lng, base.lat], [d.lng, d.lat]]
    const suspended = d.routeStatus === 'suspended'
    const rerouted = d.routeStatus === 'rerouted'
    const line = new amap.Polyline({
      path,
      strokeColor: suspended ? '#7e8aa2' : (rerouted ? '#ffc107' : d.color),
      strokeOpacity: suspended ? 0.7 : 0.9,
      strokeWeight: 4,
      lineJoin: 'round',
      lineCap: 'round',
      strokeStyle: suspended ? 'solid' : 'dashed',
      showDir: !suspended
    })
    map.add(line)
    overlays.lines.push(line)
    // 绕行途经点
    if (rerouted && d.routePoints && d.routePoints.length > 2) {
      d.routePoints.slice(1, -1).forEach((p) => {
        const wp = new amap.CircleMarker({
          center: [p[0], p[1]], radius: 6,
          strokeColor: '#fff', strokeWeight: 1.5,
          fillColor: '#ffc107', fillOpacity: 0.95
        })
        map.add(wp)
        overlays.lines.push(wp)
      })
    }
  })
}

function clearLines() {
  overlays.lines.forEach((l) => map?.remove(l))
  overlays.lines = []
}

// 安置点 Marker（🏕️ + 在住/容量角标）
function shelterMarkerContent(s) {
  const bed = transfer.bedMap[s.id] || { inHouse: 0 }
  return `
    <div class="shelter-marker" title="${s.name}（在住 ${bed.inHouse}/${s.capacity}）">
      <span>🏕️</span><em>${bed.inHouse}/${s.capacity}</em>
    </div>`
}

function renderShelters() {
  overlays.shelterMarkers.forEach((m) => map?.remove(m))
  overlays.shelterMarkers = []
  if (!amap || !map) return
  transfer.shelters.forEach((s) => {
    const marker = new amap.Marker({
      position: [s.lng, s.lat],
      content: shelterMarkerContent(s),
      anchor: 'center',
      cursor: 'pointer'
    })
    map.add(marker)
    overlays.shelterMarkers.push(marker)
  })
}

// 转移路线（受灾点 → 安置点，未办结批次；阻断后按改派/挂起着色）
function renderTransfers() {
  overlays.transferLines.forEach((l) => map?.remove(l))
  overlays.transferLines = []
  if (!amap || !map) return
  transfer.batches.forEach((b) => {
    if (b.status === 'closed') return
    const ev = store.events.find((e) => e.id === b.eventId)
    const sh = transfer.shelters.find((s) => s.id === b.shelterId)
    if (!ev || !sh) return
    const path = (b.routeWaypoints && b.routeWaypoints.length >= 2)
      ? b.routeWaypoints.map((p) => [p[0], p[1]])
      : [[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]]
    const suspended = b.routeStatus === 'suspended'
    const rerouted = b.routeStatus === 'rerouted'
    const line = new amap.Polyline({
      path,
      strokeColor: suspended ? '#7e8aa2' : (rerouted ? '#ffc107' : '#26a69a'),
      strokeOpacity: 0.85,
      strokeWeight: 3,
      lineJoin: 'round',
      lineCap: 'round',
      strokeStyle: suspended ? 'solid' : 'dashed',
      showDir: !suspended
    })
    map.add(line)
    overlays.transferLines.push(line)
  })
}

/* ---------- 道路阻断：封闭带渲染 + 地图勾绘 ---------- */

function blockageColor(status) {
  return BLOCKAGE_STATUS.find((x) => x.value === status)?.color || '#ef5350'
}

// 阻断路段：折线 + 缓冲带圆圈 + 阻断点 Marker
function renderBlockages() {
  overlays.blockageShapes.forEach((o) => map?.remove(o))
  overlays.blockageShapes = []
  if (!amap || !map) return
  rbStore.blockages.forEach((rb) => {
    const color = blockageColor(rb.status)
    const faded = rb.status === 'cleared' || rb.status === 'dismissed'
    const line = new amap.Polyline({
      path: rb.path.map((p) => [p[0], p[1]]),
      strokeColor: color,
      strokeOpacity: faded ? 0.3 : 0.95,
      strokeWeight: 5,
      lineJoin: 'round',
      lineCap: 'round',
      showDir: false
    })
    map.add(line)
    overlays.blockageShapes.push(line)
    rb.path.forEach((p) => {
      const c = new amap.Circle({
        center: [p[0], p[1]],
        radius: rb.radius,
        strokeColor: color,
        strokeOpacity: faded ? 0.15 : 0.5,
        strokeWeight: 1,
        fillColor: color,
        fillOpacity: faded ? 0.05 : 0.18
      })
      map.add(c)
      overlays.blockageShapes.push(c)
    })
    const mid = rb.path[Math.floor(rb.path.length / 2)]
    const marker = new amap.Marker({
      position: [mid[0], mid[1]],
      content: `<div class="rb-marker" style="--rc:${color}"><span>${faded ? '🟢' : '🚧'}</span></div>`,
      anchor: 'center',
      cursor: 'pointer'
    })
    marker.on('click', () => { if (rb.eventId) store.selectEvent(rb.eventId) })
    map.add(marker)
    overlays.blockageShapes.push(marker)
  })
}

// 勾绘草稿：已点的折线 + 顶点
function renderDraft() {
  overlays.draftShapes.forEach((o) => map?.remove(o))
  overlays.draftShapes = []
  if (!amap || !map) return
  const pts = rbStore.draftPath
  if (!pts.length) return
  const line = new amap.Polyline({
    path: pts.map((p) => [p[0], p[1]]),
    strokeColor: '#ff9800', strokeOpacity: 0.9, strokeWeight: 4,
    lineJoin: 'round', lineCap: 'round'
  })
  map.add(line)
  overlays.draftShapes.push(line)
  pts.forEach((p, i) => {
    const dot = new amap.CircleMarker({
      center: [p[0], p[1]], radius: 5,
      strokeColor: '#fff', strokeWeight: 1.5,
      fillColor: i === pts.length - 1 ? '#ff9800' : '#ef5350', fillOpacity: 0.95
    })
    map.add(dot)
    overlays.draftShapes.push(dot)
  })
}

function onMapClick(e) {
  if (!rbStore.drawing) return
  const p = e.lnglat
  rbStore.draftPath = [...rbStore.draftPath, [p.lng, p.lat]]
}
function finishDraw() {
  rbStore.drawing = false
}
function cancelDraw() {
  rbStore.drawing = false
  rbStore.draftPath = []
}

onMounted(async () => {
  try {
    amap = await loadAMap()
    map = new amap.Map(mapRef.value, {
      zoom: 8,
      center: [104.5, 30.9],
      mapStyle: 'amap://styles/fresh',
      viewMode: '2D',
      showLabel: true,
      features: ['bg', 'road', 'building']
    })
    const scale = new amap.Scale({ position: 'LB' })
    const toolbar = new amap.ToolBar({ position: 'RT' })
    map.addControl(scale)
    map.addControl(toolbar)
    map.on('click', onMapClick)
    renderEvents()
    renderHeatmap()
    renderShelters()
    renderTransfers()
    renderBlockages()
    renderDraft()
    loading.value = false
    map.setFitView(null, false, [100, 80, 120, 80], 1)
  } catch (e) {
    loadError.value = e.message
    loading.value = false
    console.error(e)
  }
})

onBeforeUnmount(() => {
  store.stopAutoPlay()
  map?.off('click', onMapClick)
  overlays.markers.forEach((m) => map?.remove(m))
  overlays.poly.forEach((p) => map?.remove(p))
  overlays.lines.forEach((l) => map?.remove(l))
  overlays.baseMarkers.forEach((m) => map?.remove(m))
  overlays.shelterMarkers.forEach((m) => map?.remove(m))
  overlays.transferLines.forEach((l) => map?.remove(l))
  overlays.blockageShapes.forEach((o) => map?.remove(o))
  overlays.draftShapes.forEach((o) => map?.remove(o))
  map?.destroy()
})

// 数据变化时重绘
watch(() => [store.filteredEvents.length, store.scenarioId], () => renderEvents())
watch(() => store.selectedEventId, (id) => {
  const ev = store.events.find((e) => e.id === id)
  if (ev && map) map.setFitView([], false, [100, 80, 120, 80])
})
watch(() => store.dispatches.length, () => renderDispatches())
// 派发路线被阻断处置（绕行点/改派基地/挂起）后重绘
watch(
  () => store.dispatches.map((d) => d.id + d.routeStatus + (d.baseId) + (d.routePoints?.length || 0)).join(','),
  () => renderDispatches()
)
watch(() => store.filteredEvents.map((e) => e.affected).join(','), () => {
  if (amap) renderHeatmap()
})
// 转移安置：批次变化 → 重绘转移路线；登记人数变化 → 刷新安置点角标
watch(
  () => transfer.batches.map((b) => b.id + b.status + b.shelterId + (b.routeStatus || '')).join(',') + store.scenarioId,
  () => { renderTransfers(); renderShelters() }
)
watch(
  () => transfer.batches.reduce((sum, b) => sum + b.members.filter((x) => x.checkinAt && !x.checkoutAt).length, 0),
  () => renderShelters()
)

// 道路阻断：记录变化重绘；勾绘草稿变化重绘；定位请求飞向阻断中点
watch(
  () => rbStore.blockages.map((x) => x.id + x.status).join(','),
  () => renderBlockages()
)
watch(
  () => rbStore.draftPath.map((p) => p.join(',')).join('|') + (rbStore.drawing ? 'd' : ''),
  () => renderDraft()
)
watch(() => rbStore.focusBlockageId, (id) => {
  if (!id || !map || !amap) return
  const target = rbStore.blockages.find((x) => x.id === id)
  if (!target) return
  const bounds = new amap.Bounds()
  target.path.forEach((p) => bounds.extend(new amap.LngLat(p[0], p[1])))
  map.setBounds(bounds, false, [80, 80, 80, 80])
  rbStore.focusBlockageId = null
})

// 展平 dispatch 里带坐标的辅助（供模板使用）
</script>

<style scoped>
.map-wrap {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 420px;
}
.map-container {
  width: 100%;
  height: 100%;
}
.map-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #0d1429;
  color: #8ea1c4;
  font-size: 14px;
  z-index: 2;
}
.spinner {
  width: 34px; height: 34px;
  border: 3px solid #1c2b4a;
  border-top-color: #4d8dff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.err { color: #ef5350; font-size: 12px; max-width: 320px; text-align: center; }

/* 图例 */
.legend {
  position: absolute;
  left: 12px; bottom: 40px;
  background: rgba(13, 20, 41, 0.85);
  border: 1px solid rgba(150, 180, 220, 0.2);
  border-radius: 10px;
  padding: 10px 12px;
  z-index: 3;
  color: #c6d2e6;
  font-size: 12px;
  backdrop-filter: blur(4px);
  min-width: 132px;
}
.legend-title {
  font-weight: 600; color: #fff; margin-bottom: 6px; font-size: 12px;
}
.legend-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }

/* 事件弹出卡 */
.draw-tip {
  position: absolute;
  top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: rgba(60, 24, 14, 0.92);
  border: 1px solid rgba(255, 112, 67, 0.55);
  border-radius: 8px; padding: 8px 14px;
  z-index: 4; color: #ffccbc; font-size: 12px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
}
.draw-tip button {
  background: transparent; border: 1px solid rgba(255,112,67,0.6);
  color: #ffab91; font-size: 11px; border-radius: 5px; padding: 3px 9px; cursor: pointer;
}
.draw-tip button:hover { background: rgba(255,112,67,0.18); color: #fff; }

.event-pop {
  position: absolute;
  right: 14px; bottom: 40px;
  width: 300px;
  background: rgba(15, 23, 46, 0.92);
  border: 1px solid rgba(150, 180, 220, 0.25);
  border-left: 3px solid #4d8dff;
  border-radius: 10px;
  padding: 12px 14px;
  z-index: 3;
  color: #dbe4f3;
  backdrop-filter: blur(6px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.pop-head { border-bottom: 1px dashed #2a3a5e; padding-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.pop-type {
  color: #fff; padding: 1px 8px; border-radius: 4px; font-size: 12px; flex-shrink: 0;
}
.pop-head strong { font-size: 13px; flex: 1; color: #fff; }
.pop-sev { font-size: 12px; flex-shrink: 0; }
.pop-desc { color: #aebadd; font-size: 12px; line-height: 1.6; margin: 8px 0; }
.pop-meta { display: flex; gap: 12px; font-size: 12px; color: #8ea1c4; }
</style>

<style>
/* 全局覆盖物样式（AMap 注入 DOM，不能用 scoped 控制） */
.ev-marker {
  position: relative;
  width: 30px; height: 30px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--c);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 10px rgba(0,0,0,0.4);
  border: 2px solid #fff;
}
.ev-marker .ev-icon {
  transform: rotate(45deg);
  font-size: 15px;
  color: #fff;
}
.ev-marker .ev-pulse {
  position: absolute;
  inset: -4px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(45deg);
  border: 2px solid var(--c);
  animation: evPulse 1.6s ease-out infinite;
  opacity: 0;
}
@keyframes evPulse {
  0% { transform: rotate(45deg) scale(0.7); opacity: 0.8; }
  100% { transform: rotate(45deg) scale(1.6); opacity: 0; }
}
.base-marker {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: #2962ff;
  display: flex; align-items: center; justify-content: center;
  border: 2.5px solid #fff;
  box-shadow: 0 3px 8px rgba(41,98,255,0.6);
}
.base-marker span { font-size: 13px; }
.base-marker i {
  position: absolute; width: 8px; height: 8px; border-radius: 50%;
  background: #4fc3f7; bottom: -3px; right: -2px; border: 1px solid #fff;
}
.shelter-marker {
  position: relative;
  min-width: 26px; height: 26px; padding: 0 5px;
  border-radius: 13px;
  background: #0f5e52;
  display: flex; align-items: center; justify-content: center; gap: 2px;
  border: 2.5px solid #fff;
  box-shadow: 0 3px 8px rgba(38,166,154,0.6);
}
.shelter-marker span { font-size: 13px; }
.shelter-marker em {
  font-style: normal; font-size: 9px; color: #a7f3d0; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rb-marker {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: var(--rc);
  display: flex; align-items: center; justify-content: center;
  border: 2.5px solid #fff;
  box-shadow: 0 3px 8px rgba(0,0,0,0.5);
  font-size: 13px;
}
</style>