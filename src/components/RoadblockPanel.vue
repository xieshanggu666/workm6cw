<template>
  <div class="rb-panel">
    <!-- ================= 现场上报 ================= -->
    <button v-if="!reporting" class="new-btn" @click="openReport">🚧 现场上报道路封闭范围</button>
    <div v-else class="report-form">
      <div class="cf-title">🚧 道路阻断上报</div>
      <div class="field">
        <label>关联灾情事件</label>
        <select v-model="form.eventId">
          <option value="">不关联事件</option>
          <option v-for="e in cmd.events" :key="e.id" :value="e.id">{{ e.title }}</option>
        </select>
      </div>
      <div class="grid2">
        <div class="field">
          <label>路段名称</label>
          <input v-model="form.roadName" placeholder="如：G543 江油段" />
        </div>
        <div class="field">
          <label>阻断原因</label>
          <select v-model="form.reason">
            <option v-for="r in BLOCKAGE_REASONS" :key="r.value" :value="r.value">{{ r.icon }} {{ r.label }}</option>
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label>上报人</label>
          <input v-model="form.reporter" placeholder="现场队员" />
        </div>
        <div class="field">
          <label>封闭带宽（米）</label>
          <input type="number" min="100" step="100" v-model.number="form.radius" />
        </div>
      </div>
      <div class="field">
        <label>封闭范围（地图勾绘，或下方模拟生成）</label>
        <div class="draw-box" :class="{ drawing: drawing }">
          <template v-if="draftPath.length">
            <span class="draw-ok">📍 已勾绘 {{ draftPath.length }} 个点</span>
            <button class="mini" @click="undoDraft">↶ 撤销点</button>
            <button class="mini danger" @click="clearDraft">清空</button>
          </template>
          <template v-else>
            <span>{{ drawing ? '在地图上依次点击勾绘封路路段…' : '未勾绘' }}</span>
            <button class="mini" @click="startDraw">{{ drawing ? '绘制中…' : '🖱️ 地图勾绘' }}</button>
          </template>
        </div>
      </div>
      <div class="field">
        <label>备注</label>
        <input v-model="form.note" placeholder="现场补充说明（可选）" />
      </div>
      <p v-if="reportMsg" class="msg err">{{ reportMsg }}</p>
      <div class="cf-actions">
        <button class="primary" @click="onReport">📨 提交上报</button>
        <button class="ghost" @click="quickSim">🧪 模拟封一条</button>
        <button class="ghost" @click="cancelReport">取消</button>
      </div>
    </div>

    <!-- ================= 阻断记录 ================= -->
    <div class="panel-sub">🚧 阻断路段（{{ rb.openBlockages.length }} 处待处置）</div>
    <div v-if="!rb.blockages.length" class="tiny-empty">暂无道路阻断上报</div>
    <div
      v-for="x in rb.blockages" :key="x.id"
      class="rb-card" :class="x.status"
    >
      <div class="rb-head">
        <span class="rb-status" :style="{ background: statusColor(x.status) }">{{ statusLabel(x.status) }}</span>
        <strong>{{ reasonIcon(x.reason) }} {{ x.roadName }}</strong>
      </div>
      <p class="rb-meta">
        {{ reasonLabel(x.reason) }} · 带宽约 {{ x.radius }}m · {{ x.reporter }} 上报于 {{ x.reportedAt }}
      </p>
      <p class="rb-meta" v-if="x.note">📝 {{ x.note }}</p>
      <p class="rb-meta" v-if="x.confirmedAt">指挥员确认 {{ x.confirmedAt }}<template v-if="x.clearedAt"> · 🟢 {{ x.clearedAt }} 恢复</template></p>
      <div class="rb-actions">
        <button v-if="x.status === 'reported'" class="ok" @click="onConfirm(x)">✅ 确认封路</button>
        <button v-if="x.status === 'reported'" class="danger" @click="onDismiss(x)">误报</button>
        <button v-if="x.status === 'active'" class="ok" @click="onClear(x)">🟢 恢复通行</button>
        <button v-if="x.status === 'active'" class="warn" @click="onDismiss(x)">误报撤销</button>
        <button @click="locate(x)">📍 定位</button>
      </div>
    </div>

    <!-- ================= 指挥员影响研判与处置 ================= -->
    <template v-if="impactList.length">
      <div class="panel-sub warn-sub">⚠️ 影响研判：{{ impactList.length }} 个在途任务受阻断</div>
      <div v-for="it in impactList" :key="it.key" class="impact-card" :class="{ blocked: true }">
        <div class="im-head">
          <span class="im-kind" :class="it.kind">{{ it.kind === 'dispatch' ? '📦 物资派发' : '🚌 转移批次' }}</span>
          <strong>{{ it.title }}</strong>
        </div>
        <p class="im-route">
          {{ it.origin }} → {{ it.dest }}
          <em>撞 {{ it.hitIds.length }} 处封路</em>
        </p>
        <p class="im-warn" v-if="it.targetInside">🚧 目的地在封闭带内，绕行/改派均不可达</p>
        <p class="im-warn" v-else-if="it.originInside">🚧 出发地在封闭带内，暂无出路</p>
        <p class="im-warn" v-if="it.kind === 'batch' && it.hasCheckin">🏕️ 已有群众入住，安置点不可改派</p>

        <div class="im-opts">
          <label v-if="it.kind === 'dispatch'" :class="{ off: !it.options.detour }">
            <input
              type="radio" :name="'act-' + it.key" value="detour"
              :disabled="!it.options.detour"
              v-model="decisions[it.key]"
            />
            🛣️ 绕行<span v-if="it.options.detour"> · {{ it.options.detour.distance }}km/{{ it.options.detour.minutes }}min</span>
          </label>
          <label :class="{ off: !it.options.reassign }">
            <input
              type="radio" :name="'act-' + it.key" value="reassign"
              :disabled="!it.options.reassign"
              v-model="decisions[it.key]"
            />
            🔀 改派<span v-if="it.options.reassign"> → {{ it.kind === 'dispatch' ? it.options.reassign.baseName : it.options.reassign.shelterName }} · {{ it.options.reassign.minutes }}min</span>
          </label>
          <label>
            <input type="radio" :name="'act-' + it.key" value="suspend" v-model="decisions[it.key]" />
            ⏸️ 挂起（无路可走）
          </label>
        </div>
      </div>
      <button class="exec-btn" @click="onExecute">✅ 执行处置方案（同步路线/到达时间/车辆床位）</button>
      <p v-if="execMsg" class="msg" :class="execMsg.ok ? 'ok' : 'err'">{{ execMsg.msg }}</p>
    </template>

    <!-- ================= 已改线任务恢复原线 ================= -->
    <template v-if="reroutedItems.length">
      <div class="panel-sub">🔁 已改线任务（阻断解除后可恢复原方案）</div>
      <div v-for="r in reroutedItems" :key="r.key" class="rerouted-item">
        <span>{{ r.icon }} {{ r.title }}</span>
        <button class="mini" @click="onRestore(r.key)">↩️ 恢复原方案</button>
      </div>
      <p v-if="restoreMsg" class="msg" :class="restoreMsg.ok ? 'ok' : 'err'">{{ restoreMsg.msg }}</p>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore, BLOCKAGE_STATUS, BLOCKAGE_REASONS } from '@/store/roadblock'

const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()

const reporting = ref(false)
const reportMsg = ref('')
const execMsg = ref(null)
const restoreMsg = ref(null)
const draftPath = computed(() => rb.draftPath || [])
const drawing = computed(() => rb.drawing)

const form = ref({ eventId: '', roadName: '', reason: 'landslide', reporter: '', radius: 1500, note: '' })

// 每个受影响任务的处置决定：key -> detour / reassign / suspend
const decisions = reactive({})

const impactList = computed(() => rb.analyze())
// 分析清单变化时补齐默认建议
watch(impactList, (list) => {
  list.forEach((it) => {
    if (!decisions[it.key] || !isActionAllowed(it, decisions[it.key])) {
      decisions[it.key] = it.action
    }
  })
}, { immediate: true, deep: true })

function isActionAllowed(it, action) {
  if (action === 'detour') return it.kind === 'dispatch' && !!it.options.detour
  if (action === 'reassign') return !!it.options.reassign
  return true
}

// 已改线（绕行/改派）且当前未挂起的任务
const reroutedItems = computed(() => {
  const items = []
  cmd.dispatches.forEach((d) => {
    if (d.routeStatus === 'rerouted') {
      items.push({
        key: 'd-' + d.id,
        icon: '📦',
        title: `${d.typeLabel} ${d.qty}${d.unit}（${d.actionType === 'detour' ? '绕行' : '改派 ' + d.baseName}）→ ${d.shelterName || d.eventTitle}`
      })
    }
  })
  tr.batches.forEach((b) => {
    if (b.status !== 'closed' && b.routeStatus === 'rerouted') {
      const sh = tr.shelters.find((s) => s.id === b.shelterId)
      items.push({ key: 'b-' + b.id, icon: '🚌', title: `批次「${b.name}」（改派 → ${sh?.name || ''}）` })
    }
  })
  return items
})

const statusLabel = (s) => BLOCKAGE_STATUS.find((x) => x.value === s)?.label || s
const statusColor = (s) => BLOCKAGE_STATUS.find((x) => x.value === s)?.color || '#999'
const reasonLabel = (v) => BLOCKAGE_REASONS.find((x) => x.value === v)?.label || '道路封闭'
const reasonIcon = (v) => BLOCKAGE_REASONS.find((x) => x.value === v)?.icon || '🚧'

function openReport() {
  reporting.value = true
  reportMsg.value = ''
  rb.draftPath = []
  const ev = cmd.events.find((e) => e.id === cmd.selectedEventId)
  form.value = {
    eventId: ev?.id || '',
    roadName: '', reason: 'landslide', reporter: '', radius: 1500, note: ''
  }
}
function cancelReport() {
  reporting.value = false
  rb.draftPath = []
  rb.drawing = false
}
function startDraw() {
  rb.drawing = true
}
function undoDraft() {
  rb.draftPath = rb.draftPath.slice(0, -1)
}
function clearDraft() {
  rb.draftPath = []
  rb.drawing = false
}

// 演示用：在当前选中事件与最近基地/安置点之间的连线上取两点，模拟阻断连线压在路线上
function quickSim() {
  const ev = cmd.events.find((e) => e.id === (form.value.eventId || cmd.selectedEventId)) || cmd.events[0]
  if (!ev) { reportMsg.value = '当前无灾情事件'; return }
  // 找最近的基地作为连线另一端
  let nearest = null, best = Infinity
  cmd.bases.forEach((b) => {
    const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
    if (d < best) { best = d; nearest = b }
  })
  if (!nearest) return
  const p1 = [
    ev.location.lng + (nearest.lng - ev.location.lng) * 0.42 - 0.02,
    ev.location.lat + (nearest.lat - ev.location.lat) * 0.42 + 0.015
  ]
  const p2 = [
    ev.location.lng + (nearest.lng - ev.location.lng) * 0.58 + 0.02,
    ev.location.lat + (nearest.lat - ev.location.lat) * 0.58 - 0.015
  ]
  rb.draftPath = [p1, p2]
  if (!form.value.eventId) form.value.eventId = ev.id
  if (!form.value.roadName) form.value.roadName = `${ev.location.name || '灾区'}附近道路`
}

function onReport() {
  const r = rb.report({ ...form.value, path: rb.draftPath })
  if (!r.ok) { reportMsg.value = r.msg; return }
  cancelReport()
}

function onConfirm(x) {
  rb.confirm(x.id)
}
function onDismiss(x) {
  rb.dismiss(x.id)
}
function onClear(x) {
  execMsg.value = null
  const r = rb.clear(x.id)
  if (r.ok) {
    execMsg.value = {
      ok: true,
      msg: r.resumed ? `已恢复通行，${r.resumed} 个挂起任务自动续派${r.stillBlocked ? `，${r.stillBlocked} 个仍受其他封路阻挡` : ''}` : '已恢复通行'
    }
  }
}
function locate(x) {
  cmd.selectEvent(x.eventId || cmd.events[0]?.id)
  rb.focusBlockageId = x.id
}

function onExecute() {
  const list = impactList.value
  const payload = list
    .filter((it) => decisions[it.key])
    .map((it) => ({ key: it.key, action: decisions[it.key] }))
  if (!payload.length) { execMsg.value = { ok: false, msg: '请先为受影响任务选择处置方式' }; return }
  const r = rb.execute(payload)
  const parts = []
  if (r.detour) parts.push(`绕行 ${r.detour}`)
  if (r.reassign) parts.push(`改派 ${r.reassign}`)
  if (r.suspended) parts.push(`挂起 ${r.suspended}`)
  execMsg.value = {
    ok: !r.failed.length,
    msg: `已执行：${parts.join('、') || '无'}${r.failed.length ? '；失败：' + r.failed.join('，') : ''}`
  }
}

function onRestore(key) {
  const r = rb.restoreRoute(key)
  restoreMsg.value = r.ok ? { ok: true, msg: '已恢复原方案' } : { ok: false, msg: r.msg }
}

watch(() => cmd.scenarioId, () => {
  reporting.value = false
  execMsg.value = null
  restoreMsg.value = null
  Object.keys(decisions).forEach((k) => delete decisions[k])
})
</script>

<style scoped>
.rb-panel { display: flex; flex-direction: column; gap: 9px; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #ff7043; padding-left: 8px; margin: 4px 0 0;
}
.warn-sub { color: #ffab91; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }

.new-btn {
  width: 100%; padding: 9px; border: 1px dashed rgba(255,112,67,0.55); border-radius: 8px;
  background: rgba(255,112,67,0.08); color: #ffab91; font-size: 12px; font-weight: 600; cursor: pointer;
}
.new-btn:hover { background: rgba(255,112,67,0.16); }

.report-form {
  background: #101d39; border: 1px solid rgba(255,112,67,0.3);
  border-radius: 10px; padding: 12px;
}
.cf-title { font-size: 12px; font-weight: 600; color: #ffab91; margin-bottom: 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 7px 8px; font-size: 12px; box-sizing: border-box;
}
.draw-box {
  display: flex; align-items: center; gap: 8px;
  background: #0c1730; border: 1px dashed rgba(120,160,220,0.3);
  border-radius: 7px; padding: 7px 9px; font-size: 11px; color: #8ba2c8;
}
.draw-box.drawing { border-color: #ff7043; color: #ffab91; }
.draw-ok { color: #7ef0c9; flex: 1; }
.mini {
  background: transparent; border: 1px solid rgba(120,160,220,0.35);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.mini:hover { color: #fff; border-color: #4d8dff; }
.mini.danger:hover { color: #ef5350; border-color: #ef5350; }
.cf-actions { display: flex; gap: 7px; flex-wrap: wrap; }
.primary {
  flex: 1; padding: 8px; border: none; border-radius: 7px;
  background: linear-gradient(135deg, #b33a18, #ff7043);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.primary:hover { filter: brightness(1.12); }
.ghost {
  padding: 8px 12px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 11px; border-radius: 7px; cursor: pointer;
}
.ghost:hover { color: #fff; border-color: #4d8dff; }
.msg { font-size: 11px; margin: 0; }
.msg.ok { color: #7ef0c9; }
.msg.err { color: #ef9a9a; }

/* 阻断记录卡 */
.rb-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-left: 3px solid #7e8aa2; border-radius: 9px; padding: 9px 10px;
}
.rb-card.reported { border-left-color: #ff9800; }
.rb-card.active { border-left-color: #ef5350; background: rgba(60,20,14,0.25); }
.rb-card.cleared, .rb-card.dismissed { opacity: 0.6; }
.rb-head { display: flex; align-items: center; gap: 7px; }
.rb-status { color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.rb-head strong { font-size: 12px; color: #fff; flex: 1; min-width: 0; }
.rb-meta { font-size: 10px; color: #8ba2c8; margin: 4px 0 0; }
.rb-actions { display: flex; gap: 6px; margin-top: 8px; }
.rb-actions button {
  flex: 1; padding: 5px 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #8ba2c8; font-size: 11px; border-radius: 6px; cursor: pointer;
}
.rb-actions button:hover { color: #fff; border-color: #4d8dff; }
.rb-actions .ok:hover { color: #7ef0c9; border-color: #26a69a; }
.rb-actions .danger:hover { color: #ef5350; border-color: #ef5350; }
.rb-actions .warn:hover { color: #ffc107; border-color: #ffc107; }

/* 影响研判卡 */
.impact-card {
  background: rgba(60,24,14,0.28); border: 1px solid rgba(255,112,67,0.35);
  border-radius: 9px; padding: 9px 10px;
}
.im-head { display: flex; align-items: center; gap: 7px; }
.im-kind {
  font-size: 10px; padding: 2px 7px; border-radius: 4px; flex-shrink: 0;
  background: rgba(47,156,245,0.2); color: #7eb6f5;
}
.im-kind.batch { background: rgba(38,166,154,0.2); color: #7ef0c9; }
.im-head strong { font-size: 12px; color: #fff; }
.im-route { font-size: 10px; color: #8ba2c8; margin: 5px 0 0; display: flex; justify-content: space-between; gap: 6px; }
.im-route em { font-style: normal; color: #ffab91; flex-shrink: 0; }
.im-warn { font-size: 10px; color: #ef9a9a; margin: 4px 0 0; }
.im-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; }
.im-opts label {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: #dbe4f3; cursor: pointer;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 6px; padding: 6px 8px;
}
.im-opts label.off { opacity: 0.45; cursor: not-allowed; }
.im-opts label span { color: #ffc107; }
.im-opts input { accent-color: #ff7043; }

.exec-btn {
  width: 100%; padding: 9px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #b33a18, #ff7043);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer;
}
.exec-btn:hover { filter: brightness(1.12); }

.rerouted-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(255,193,7,0.25);
  border-radius: 7px; padding: 6px 9px; font-size: 11px; color: #dbe4f3;
}
</style>
