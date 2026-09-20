<template>
  <div class="dispatch">
    <!-- 页签：单点派发 / 统筹方案 / 转移安置 -->
    <div class="tabs">
      <button :class="{ active: tab === 'single' }" @click="tab = 'single'">🎯 单点派发</button>
      <button :class="{ active: tab === 'plan' }" @click="tab = 'plan'">
        🧮 统筹方案<span v-if="store.plan.length" class="badge">{{ store.plan.length }}</span>
      </button>
      <button :class="{ active: tab === 'transfer' }" @click="tab = 'transfer'">
        🚌 转移安置<span v-if="transfer.stats.activeBatches" class="badge teal">{{ transfer.stats.activeBatches }}</span>
      </button>
    </div>

    <template v-if="tab === 'single'">
    <!-- 当前选中事件 -->
    <div v-if="selectedEvent" class="current-ev">
      <strong>{{ selectedEvent.title }}</strong>
      <p>🧑‍🚒 所需资源清单（已派 / 需求）</p>
      <div class="demand-row" v-for="(qty, type) in selectedEvent.demand" :key="type">
        <span class="d-label">{{ resLabel(type) }} {{ resIcon(type) }}</span>
        <div class="d-bar"><i :style="{ width: fillPct(type) }"></i></div>
        <span class="d-qty">{{ sentOf(type) }}/{{ qty }}{{ resUnit(type) }}</span>
      </div>
    </div>
    <div v-else class="placeholder">← 在地图上或左侧选择一个事件进行调度</div>

    <!-- 派发表单 -->
    <div class="dispatch-form" v-if="selectedEvent">
      <div class="form-title">派发救援资源</div>
      <div class="grid">
        <div class="field">
          <label>资源基地</label>
          <select v-model="form.baseId">
            <option v-for="b in store.bases" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>资源类型</label>
          <select v-model="form.type">
            <option v-for="(v,k) in RESOURCE_TYPES" :key="k" :value="k">{{ v.label }}</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>数量（库存：{{ maxQty }}）</label>
        <input type="number" min="0" :max="maxQty" v-model.number="form.qty" />
      </div>
      <button class="dispatch-btn" :disabled="!canDispatch" @click="onDispatch">
        🚀 派发 {{ formQtyLabel }}
      </button>
      <p class="hint">派发后自动在地图绘制路线、估算距离与到达时间</p>
    </div>

    <!-- 资源库库存总览 -->
    <div class="bases">
      <div class="panel-sub">📦 资源库 / 救援点库存</div>
      <div class="base-card" v-for="b in store.bases" :key="b.id">
        <div class="base-head">
          <span class="base-icon">🏗️</span>
          <div class="base-info">
            <strong>{{ b.name }}</strong>
            <p>余量可视列</p>
          </div>
        </div>
        <div class="base-stocks" v-if="b.stock">
          <span v-for="(v,k) in b.stock" :key="k" class="stock-chip"
                :class="{ zero: v === 0 }">{{ resLabel(k) }} {{ v }}</span>
        </div>
      </div>
    </div>

    <!-- 派发记录 -->
    <div class="dispatches">
      <div class="panel-sub">🚚 在途派发记录</div>
      <div v-if="store.dispatches.length === 0" class="tiny-empty">暂无派发</div>
      <div v-for="d in store.dispatches" :key="d.id" class="dispatch-item">
        <div class="di-head">
          <span class="di-dot" :style="{ background: d.color }"></span>
          <strong>{{ d.typeLabel }}</strong>
          <span v-if="d.source" class="di-src" :class="{ plan: d.source === '统筹' }">{{ d.source }}</span>
          <span class="di-qty">{{ d.qty }}{{ d.unit }}</span>
        </div>
        <p class="di-sub">{{ d.baseName }} → {{ d.eventTitle }}</p>
        <p class="di-meta">{{ d.at }} · {{ d.distance }}km · 约{{ d.minutes }}min</p>
        <button class="undo" @click="store.withdrawDispatch(d.id)">撤回</button>
      </div>
    </div>
    </template>

    <!-- 多灾点统筹方案 -->
    <PlanPanel v-else-if="tab === 'plan'" />

    <!-- 群众转移安置 -->
    <TransferPanel v-else />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { RESOURCE_TYPES } from '@/mock/data'
import PlanPanel from '@/components/PlanPanel.vue'
import TransferPanel from '@/components/TransferPanel.vue'

const store = useCommandStore()
const transfer = useTransferStore()
const tab = ref('single')
const form = ref({ baseId: '', type: 'personnel', qty: 0 })

const selectedEvent = computed(() =>
  store.events.find((e) => e.id === store.selectedEventId) || null
)
const resLabel = computed(() => (k) => RESOURCE_TYPES[k]?.label || k)
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''

// 当前选中的基地与类型剩余库存
const currentBase = computed(() => store.bases.find((b) => b.id === form.value.baseId))
const maxQty = computed(() => {
  if (!currentBase.value || !form.value.type) return 0
  return currentBase.value.stock[form.value.type] || 0
})
const canDispatch = computed(() =>
  !!selectedEvent.value && !!form.value.baseId && form.value.qty > 0 && form.value.qty <= maxQty.value
)
const formQtyLabel = computed(() => {
  if (!selectedEvent.value) return ''
  const qty = form.value.qty > 0 ? `${form.value.qty}` : '0'
  return `${qty}${resUnit(form.value.type)}`
})

// 事件需求条：在途已满足量与满足率
const sentOf = (type) => {
  if (!selectedEvent.value) return 0
  return store.sentMap[selectedEvent.value.id]?.[type] || 0
}
function fillPct(type) {
  const need = selectedEvent.value?.demand?.[type] || 0
  if (!need) return '0%'
  return Math.min(100, Math.round((sentOf(type) / need) * 100)) + '%'
}

function onDispatch() {
  const rec = store.dispatchResource({
    baseId: form.value.baseId,
    eventId: selectedEvent.value.id,
    type: form.value.type,
    qty: form.value.qty
  })
  if (rec) form.value.qty = 0
}

watch(() => store.scenarioId, () => {
  form.value = { baseId: '', type: 'personnel', qty: 0 }
})
watch(selectedEvent, (ev) => {
  if (ev) {
    // 默认选择距受灾点最近的基地
    let nearest = null, best = Infinity
    store.bases.forEach((b) => {
      const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
      if (d < best) { best = d; nearest = b }
    })
    form.value.baseId = nearest ? nearest.id : (store.bases[0]?.id || '')
  }
}, { immediate: true })
</script>

<style scoped>
.dispatch {
  display: flex; flex-direction: column; height: 100%;
  min-height: 0; padding: 12px; gap: 12px; overflow-y: auto;
}
.dispatch::-webkit-scrollbar { width: 6px; }
.dispatch::-webkit-scrollbar-thumb { background: #1c2b4a; border-radius: 4px; }
.panel-title { font-size: 15px; font-weight: 700; color: #fff; }
.tabs { display: flex; gap: 6px; }
.tabs button {
  flex: 1; padding: 8px; background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; font-size: 12px; font-weight: 600; border-radius: 8px; cursor: pointer;
  transition: all 0.2s; position: relative;
}
.tabs button.active {
  background: linear-gradient(135deg, #1d3f8f, #2962ff); color: #fff;
  border-color: transparent; box-shadow: 0 3px 10px rgba(41,98,255,0.35);
}
.badge {
  display: inline-block; min-width: 16px; margin-left: 5px; padding: 0 4px;
  background: #9c4dff; color: #fff; font-size: 10px; line-height: 16px;
  border-radius: 8px; vertical-align: 1px;
}
.badge.teal { background: #26a69a; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #4d8dff; padding-left: 8px; margin: 6px 0;
}

.current-ev {
  background: #101d39; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 10px; padding: 12px;
}
.current-ev strong { color: #fff; font-size: 13px; display: block; margin-bottom: 8px; }
.current-ev P { color: #8ba2c8; font-size: 11px; margin: 0 0 6px; }
.demand-row {
  display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px;
}
.d-label { width: 78px; color: #aebadd; flex-shrink: 0; }
.d-bar { flex: 1; height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; }
.d-bar i { display: block; height: 100%; background: linear-gradient(90deg, #4d8dff, #7e9ff5); border-radius: 3px; }
.d-qty { width: 86px; text-align: right; color: #ffc107; flex-shrink: 0; font-size: 10px; }
.placeholder {
  color: #5b6f94; font-size: 12px; text-align: center;
  border: 1px dashed rgba(120,160,220,0.2); border-radius: 10px; padding: 24px 12px;
}

.dispatch-form { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 12px; }
.form-title { font-size: 12px; font-weight: 600; color: #8ba2c8; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; color: #8ba2c8; margin-bottom: 4px; }
.field select, .field input {
  width: 100%; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 7px; padding: 8px; font-size: 12px;
  box-sizing: border-box;
}
.dispatch-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: all 0.2s;
}
.dispatch-btn:hover:not(:disabled) { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(41,98,255,0.4); }
.dispatch-btn:disabled { background: #1a2747; color: #5b6f94; cursor: not-allowed; }
.hint { font-size: 10px; color: #5b6f94; margin: 8px 0 0; }

.bases { display: flex; flex-direction: column; gap: 8px; }
.base-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 10px;
}
.base-head { display: flex; align-items: center; gap: 8px; }
.base-icon { font-size: 18px; }
.base-info strong { color: #dbe4f3; font-size: 12px; }
.base-info P { font-size: 10px; color: #5b6f94; margin: 0; }
.base-stocks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.stock-chip {
  font-size: 10px; background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  color: #8ba2c8; padding: 2px 6px; border-radius: 4px;
}
.stock-chip.zero { color: #4a5875; text-decoration: line-through; }

.dispatches { display: flex; flex-direction: column; gap: 8px; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
.dispatch-item {
  position: relative;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 9px 40px 9px 10px;
}
.di-head { display: flex; align-items: center; gap: 7px; }
.di-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.di-head strong { color: #dbe4f3; font-size: 12px; }
.di-src {
  font-size: 9px; padding: 1px 5px; border-radius: 4px;
  background: rgba(120,160,220,0.15); color: #8ba2c8;
}
.di-src.plan { background: rgba(156,77,255,0.2); color: #ce93ff; }
.di-qty { margin-left: auto; color: #ffc107; font-size: 12px; font-weight: 700; }
.di-sub { font-size: 10px; color: #8ba2c8; margin: 4px 0 0; }
.di-meta { font-size: 10px; color: #5b6f94; margin: 2px 0 0; }
.undo {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  background: transparent; border: 1px solid rgba(239,83,80,0.4); color: #ef5350;
  font-size: 11px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.undo:hover { background: rgba(239,83,80,0.15); }
</style>