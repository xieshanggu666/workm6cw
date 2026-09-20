import { defineStore } from 'pinia'
import {
  SCENARIOS, RESOURCE_BASES, EVENT_TYPES, RESOURCE_TYPES, SEVERITY, EVENT_STATUS
} from '@/mock/data'
import { useRoadblockStore } from '@/store/roadblock'
import { routeHitAny } from '@/utils/geo'

// 灾情等级权重（统筹分配优先级：等级高者优先锁定库存）
const SEV_WEIGHT = { red: 4, orange: 3, yellow: 2, blue: 1 }

// 用高德驾车插件视线估算距离与时长（直线 x 路网系数，演示用）
export function roughPath(lng1, lat1, lng2, lat2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  const dist = 2 * R * Math.asin(Math.sqrt(a))
  const roadDist = Math.round(dist * 1.25 * 10) / 10 // 路网折算
  const minutes = Math.round((roadDist / 55) * 60 + 8) // 55km/h 平均 + 装卸
  return { distance: roadDist, minutes }
}

let dpSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

export const useCommandStore = defineStore('command', {
  state: () => ({
    scenarioId: SCENARIOS[0].id,
    events: [],
    bases: [],
    // 派发记录与在途状态
    dispatches: [],
    // 多灾点统筹：未提交的跨基地分配方案 / 最近一次批量派发结果
    plan: [],
    planResult: null,
    // 大屏统计
    selectedEventId: null,
    filter: { type: 'all', severity: 'all', status: 'all' },
    search: '',
    autoPlay: false,
    replayTimer: null
  }),

  getters: {
    scenario(state) {
      return SCENARIOS.find((s) => s.id === state.scenarioId)
    },
    filteredEvents(state) {
      let list = [...state.events]
      if (state.filter.type !== 'all') list = list.filter((e) => e.type === state.filter.type)
      if (state.filter.severity !== 'all') list = list.filter((e) => e.severity === state.filter.severity)
      if (state.filter.status !== 'all') list = list.filter((e) => e.status === state.filter.status)
      if (state.search) list = list.filter((e) => e.title.includes(state.search) || (e.location && e.location.name.includes(state.search)))
      return list
    },
    // 各事件在途已满足量：eventId -> { type: qty }（安置点补给记录无 eventId，跳过）
    sentMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        m[d.eventId] = m[d.eventId] || {}
        m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + d.qty
      })
      return m
    },
    // 各事件需求缺口：需求 - 在途 - 方案预占
    gaps(state) {
      const planned = {}
      state.plan.forEach((p) => {
        planned[p.eventId] = planned[p.eventId] || {}
        planned[p.eventId][p.type] = (planned[p.eventId][p.type] || 0) + p.qty
      })
      return state.events.map((ev) => {
        const gap = {}
        Object.entries(ev.demand || {}).forEach(([t, need]) => {
          const g = need - (this.sentMap[ev.id]?.[t] || 0) - (planned[ev.id]?.[t] || 0)
          if (g > 0) gap[t] = g
        })
        return { eventId: ev.id, gap }
      })
    },
    // 方案冲突检测：按 基地+类型 汇总预占，超出当前库存即冲突（提交时将触发重分配）
    planConflicts(state) {
      const use = {}
      state.plan.forEach((p) => {
        const k = p.baseId + '|' + p.type
        use[k] = (use[k] || 0) + p.qty
      })
      const conflicts = {}
      Object.entries(use).forEach(([k, qty]) => {
        const [baseId, type] = k.split('|')
        const base = state.bases.find((b) => b.id === baseId)
        const stock = base ? base.stock[type] || 0 : 0
        if (qty > stock) conflicts[k] = { planned: qty, stock }
      })
      return conflicts
    },
    // 大屏统计卡片
    stats(state) {
      const counts = { listed: state.events.length }
      SEVERITY.forEach((s) => {
        counts[s.value] = state.events.filter((e) => e.severity === s.value).length
      })
      counts.dispatching = state.events.filter((e) => e.status === 'dispatching').length
      counts.closed = state.events.filter((e) => e.status === 'closed').length
      counts.dispatchedToday = state.dispatches.length
      const totalAffected = state.events.reduce((sum, e) => sum + (e.affected || 0), 0)
      return { ...counts, totalAffected }
    },
    typeLabels() {
      return EVENT_TYPES
    }
  },

  actions: {
    loadScenario(id) {
      this.scenarioId = id
      const s = this.scenario
      this.events = s.events.map((e) => ({
        ...e,
        timeline: [
          { at: e.reportedAt, text: `事件上报：${e.title}` }
        ]
      }))
      this.bases = RESOURCE_BASES.map((b) => ({ ...b, stock: { ...b.stock } }))
      this.dispatches = []
      this.plan = []
      this.planResult = null
      this.selectedEventId = this.events[0] ? this.events[0].id : null
    },
    selectEvent(id) {
      this.selectedEventId = id
    },
    // 状态流转到下一步
    advanceStatus(eventId, toStatus) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      const from = EVENT_STATUS.find((s) => s.value === ev.status)
      const to = EVENT_STATUS.find((s) => s.value === toStatus)
      ev.status = toStatus
      ev.timeline.push({ at: nowStr(), text: `状态变更：${from.label} → ${to.label}` })
    },
    // 内部：扣库存 + 生成派发记录 + 联动事件状态/时间线（库存需已校验）
    _pushDispatch(baseId, eventId, type, qty, source = '手动') {
      const base = this.bases.find((b) => b.id === baseId)
      const ev = this.events.find((e) => e.id === eventId)
      if (!base || !ev || qty <= 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, eventId, eventTitle: ev.title,
        lng: ev.location.lng, lat: ev.location.lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: EVENT_TYPES[ev.type].color, source,
        // 道路阻断联动：normal 正常 / rerouted 已改线 / suspended 已挂起
        routeStatus: 'normal', actionType: null, routePoints: null,
        blockedBy: null, suspendBy: null, suspendSnapshot: null,
        originalRoute: null, originalBaseId: null, routeAt: null
      }
      this.dispatches.unshift(record)
      ev.timeline.push({ at: record.at, text: `${source}派发 ${record.typeLabel} ${qty}${record.unit}👈${base.name}` })
      if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      this._checkNewDispatchBlocked(record)
      return record
    },
    // 新建派发时若正撞上已确认封路：自动挂起，等待恢复通行续派
    _checkNewDispatchBlocked(record) {
      const rbStore = useRoadblockStore()
      const actives = rbStore.activeBlockages
      if (!actives.length) return
      const base = this.bases.find((b) => b.id === record.baseId)
      if (!base) return
      if (routeHitAny([[base.lng, base.lat], [record.lng, record.lat]], actives)) {
        rbStore._suspendDispatch(record, actives.map((x) => x.id))
      }
    },
    // 从资源库派发资源到受灾点
    dispatchResource({ baseId, eventId, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base) return null
      qty = Math.max(0, Math.min(qty, base.stock[type] || 0))
      if (qty === 0) return null
      return this._pushDispatch(baseId, eventId, type, qty, '手动')
    },
    // 向安置点补给物资（联动转移安置模块，不计入事件需求缺口）
    dispatchToShelter({ baseId, shelterId, shelterName, lng, lat, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base || qty <= 0) return null
      qty = Math.min(qty, base.stock[type] || 0)
      if (qty === 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, lng, lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, shelterId, shelterName,
        lng, lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: '#26a69a', source: '安置补给',
        routeStatus: 'normal', actionType: null, routePoints: null,
        blockedBy: null, suspendBy: null, suspendSnapshot: null,
        originalRoute: null, originalBaseId: null, routeAt: null
      }
      this.dispatches.unshift(record)
      this._checkNewDispatchBlocked(record)
      return record
    },
    withdrawDispatch(recordId) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] += rec.qty
      this.dispatches = this.dispatches.filter((d) => d.id !== recordId)
    },

    /* ---------- 多灾点资源统筹 ---------- */

    // 按 灾情等级 → 需求缺口 → 运输时长 生成跨基地分配方案（预占不扣库存，提交时才锁定）
    generatePlan() {
      const avail = {}
      this.bases.forEach((b) => { avail[b.id] = { ...b.stock } })
      // 按等级权重、缺口规模排序事件
      const queue = this.events
        .filter((e) => e.status !== 'closed')
        .map((ev) => {
          const gap = {}
          let total = 0
          Object.entries(ev.demand || {}).forEach(([t, need]) => {
            const g = need - (this.sentMap[ev.id]?.[t] || 0)
            if (g > 0) { gap[t] = g; total += g }
          })
          return { ev, gap, total }
        })
        .filter((x) => x.total > 0)
        .sort((a, b) => (SEV_WEIGHT[b.ev.severity] - SEV_WEIGHT[a.ev.severity]) || (b.total - a.total))

      const items = []
      let seq = 0
      queue.forEach(({ ev, gap }) => {
        Object.entries(gap).forEach(([type, g]) => {
          let need = g
          // 候选基地按运输时长升序，就近优先、跨基地拆分
          const cands = this.bases
            .filter((b) => (avail[b.id][type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const c of cands) {
            if (need <= 0) break
            const take = Math.min(need, avail[c.b.id][type])
            avail[c.b.id][type] -= take
            need -= take
            items.push({
              id: 'pi-' + ++seq,
              eventId: ev.id, baseId: c.b.id, type, qty: take,
              distance: c.path.distance, minutes: c.path.minutes
            })
          }
        })
      })
      this.plan = items
      this.planResult = null
    },
    // 人工调整：改数量 / 换基地（自动重算运输时长）
    updatePlanItem(id, patch) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return
      if (patch.qty != null) it.qty = Math.max(1, Math.round(patch.qty))
      if (patch.baseId && patch.baseId !== it.baseId) {
        const base = this.bases.find((b) => b.id === patch.baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (base && ev) {
          it.baseId = patch.baseId
          const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
          it.distance = path.distance
          it.minutes = path.minutes
        }
      }
    },
    removePlanItem(id) {
      this.plan = this.plan.filter((p) => p.id !== id)
    },
    clearPlan() {
      this.plan = []
    },
    // 提交：统一校验 → 锁定库存 → 冲突重分配 → 批量派发（联动事件/路线/统计）
    submitPlan() {
      if (!this.plan.length) return null
      const remaining = {}
      this.bases.forEach((b) => { remaining[b.id] = { ...b.stock } })
      const evOf = (id) => this.events.find((e) => e.id === id)
      // 高等级事件、短运输时长优先锁定库存
      const items = [...this.plan].sort((a, b) => {
        const wa = SEV_WEIGHT[evOf(a.eventId)?.severity] || 0
        const wb = SEV_WEIGHT[evOf(b.eventId)?.severity] || 0
        return wb - wa || a.minutes - b.minutes
      })
      const takes = []
      const result = { total: items.length, ok: 0, realloc: 0, unmet: [], at: nowStr() }
      items.forEach((it) => {
        const ev = evOf(it.eventId)
        let need = it.qty
        const parts = []
        const own = Math.min(need, remaining[it.baseId]?.[it.type] || 0)
        if (own > 0) { parts.push({ baseId: it.baseId, qty: own }); need -= own }
        if (need > 0 && ev) {
          // 冲突：原基地库存不足，按运输时长从其他基地重新分配
          const alts = this.bases
            .filter((b) => b.id !== it.baseId && (remaining[b.id][it.type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const a of alts) {
            if (need <= 0) break
            const t = Math.min(need, remaining[a.b.id][it.type])
            parts.push({ baseId: a.b.id, qty: t })
            need -= t
          }
        }
        if (parts.some((p) => p.baseId !== it.baseId) || parts.length > 1) result.realloc++
        else if (parts.length) result.ok++
        if (need > 0) {
          result.unmet.push({ eventTitle: ev?.title || it.eventId, type: it.type, qty: need })
        }
        parts.forEach((p) => {
          remaining[p.baseId][it.type] -= p.qty // 锁定库存
          takes.push({ baseId: p.baseId, eventId: it.eventId, type: it.type, qty: p.qty })
        })
      })
      // 批量执行：扣库存 + 生成派发记录 + 联动事件状态/时间线（路线与统计由响应式自动更新）
      takes.forEach((t) => this._pushDispatch(t.baseId, t.eventId, t.type, t.qty, '统筹'))
      this.plan = []
      this.planResult = result
      return result
    },

    // 大屏数据自动刷新（模拟实时数据变化演示）
    startAutoPlay() {
      if (this.autoPlay) return
      this.autoPlay = true
      this.replayTimer = setInterval(() => {
        this.events.forEach((e) => {
          if (e.status !== 'closed' && Math.random() > 0.55) {
            e.affected += Math.floor(Math.random() * 60)
          }
        })
      }, 4000)
    },
    stopAutoPlay() {
      this.autoPlay = false
      clearInterval(this.replayTimer)
    },
    resetResource(eventId) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      // 撤回该事件关联的所有派发
      this.dispatches = this.dispatches.filter((d) => {
        if (d.eventId !== eventId) return true
        const base = this.bases.find((b) => b.id === d.baseId)
        if (base) base.stock[d.type] += d.qty
        return false
      })
    }
  }
})
