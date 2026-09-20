import { defineStore } from 'pinia'
import { useCommandStore, pathMetrics } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { pointInPolygon, pathBlocked, detourPath } from '@/utils/geo'

let blkSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 道路阻断处置：现场上报 → 影响评估 → 指挥员确认 → 绕行/改派/挂起 → 恢复通行 → 续派
export const useRoadblockStore = defineStore('roadblock', {
  state: () => ({
    blocks: [],          // 道路阻断记录
    drawing: false,      // 地图圈画模式
    draft: [],           // 圈画中的顶点
    reporting: false,    // 上报表单打开中
    selectedBlockId: null
  }),

  getters: {
    activeBlocks: (s) => s.blocks.filter((b) => b.status === 'active'),
    // 所有生效阻断的封闭范围（改派/续派时需全部避开）
    activePolygons() { return this.activeBlocks.map((b) => b.polygon) },
    heldDispatches() {
      return useCommandStore().dispatches.filter((d) => d.status === 'held')
    },
    heldBatches() {
      return useTransferStore().batches.filter((b) => b.held)
    },
    heldCount() { return this.heldDispatches.length + this.heldBatches.length }
  },

  actions: {
    _cmd() { return useCommandStore() },
    _tr() { return useTransferStore() },
    _block(id) { return this.blocks.find((b) => b.id === id) },
    _log(blk, text) { blk.log.push({ at: nowStr(), text }) },

    load() {
      this.blocks = []
      this.drawing = false
      this.draft = []
      this.reporting = false
      this.selectedBlockId = null
    },

    /* ---------- 现场上报：地图圈画封闭范围 ---------- */

    startDrawing() {
      this.drawing = true
      this.draft = []
      this.reporting = false
    },
    addDraftPoint(lng, lat) {
      const last = this.draft[this.draft.length - 1]
      if (last && Math.abs(last[0] - lng) < 1e-6 && Math.abs(last[1] - lat) < 1e-6) return
      this.draft.push([+lng.toFixed(6), +lat.toFixed(6)])
    },
    undoDraftPoint() { this.draft.pop() },
    cancelDrawing() { this.drawing = false; this.draft = [] },
    cancelReport() { this.reporting = false; this.draft = [] },
    finishDrawing() {
      // 双击/右键收尾时去除过近的重复点
      const pts = []
      this.draft.forEach((p) => {
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.0005) pts.push(p)
      })
      if (pts.length < 3) return false
      this.draft = pts
      this.drawing = false
      this.reporting = true
      return true
    },
    // 快捷上报：在当前事件与最近资源基地的运输走廊上生成封闭区（演示用）
    quickPolygon(eventId) {
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!ev) return null
      let nb = null, best = Infinity
      cmd.bases.forEach((b) => {
        const d = Math.hypot(b.lng - ev.location.lng, b.lat - ev.location.lat)
        if (d < best) { best = d; nb = b }
      })
      const cx = (ev.location.lng + (nb?.lng ?? ev.location.lng + 0.2)) / 2
      const cy = (ev.location.lat + (nb?.lat ?? ev.location.lat)) / 2
      const r = 0.055
      const poly = []
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6
        poly.push([+(cx + r * Math.cos(a)).toFixed(5), +(cy + r * Math.sin(a) * 1.15).toFixed(5)])
      }
      return poly
    },

    // 提交上报：落库并自动做影响评估
    reportBlock({ name, reason, reporter, polygon }) {
      if (!polygon || polygon.length < 3) return { ok: false, msg: '封闭范围至少需要 3 个顶点' }
      const blk = {
        id: 'blk-' + Date.now() + '-' + ++blkSeq,
        name: name?.trim() || `道路阻断-${this.blocks.length + 1}`,
        reason: reason || '道路中断',
        reporter: reporter?.trim() || '现场巡查员',
        polygon,
        status: 'active',
        reportedAt: nowStr(),
        clearedAt: null,
        impacts: [],     // 影响评估结果（指挥员确认后生成方案）
        confirmed: false,
        log: []
      }
      this.blocks.unshift(blk)
      this._log(blk, `🚧 ${blk.reporter} 上报道路封闭范围（${polygon.length} 个顶点）`)
      this.reporting = false
      this.draft = []
      this.selectedBlockId = blk.id
      this.assess(blk.id)
      return { ok: true, block: blk }
    },

    /* ---------- 影响评估：路线与封闭范围相交的在途派发 / 转移批次 ---------- */

    assess(blockId) {
      const blk = this._block(blockId)
      if (!blk) return
      const cmd = this._cmd()
      const tr = this._tr()
      const impacts = []
      cmd.dispatches.forEach((d) => {
        if (d.status === 'held') return
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) return
        const pts = [[base.lng, base.lat], ...(d.via || []), [d.lng, d.lat]]
        const destIn = pointInPolygon([d.lng, d.lat], blk.polygon)
        if (destIn || pathBlocked(pts, blk.polygon)) {
          impacts.push({
            key: 'dp-' + d.id, kind: 'dispatch', id: d.id, checked: true,
            destInside: destIn, originInside: false,
            label: `${d.typeLabel} ${d.qty}${d.unit}｜${d.baseName} → ${d.eventTitle || d.shelterName}`,
            done: false, plan: null, options: [], result: null
          })
        }
      })
      tr.batches.forEach((b) => {
        if (b.status === 'closed' || b.held) return
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) return
        const pts = [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]]
        const destIn = pointInPolygon([sh.lng, sh.lat], blk.polygon)
        const originIn = pointInPolygon([ev.location.lng, ev.location.lat], blk.polygon)
        if (destIn || originIn || pathBlocked(pts, blk.polygon)) {
          impacts.push({
            key: 'tb-' + b.id, kind: 'batch', id: b.id, checked: true,
            destInside: destIn, originInside: originIn,
            label: `${b.name} ${b.headcount}人｜${ev.location.name} → ${sh.name}`,
            done: false, plan: null, options: [], result: null
          })
        }
      })
      blk.impacts = impacts
      blk.confirmed = false
      const nd = impacts.filter((i) => i.kind === 'dispatch').length
      const nb = impacts.filter((i) => i.kind === 'batch').length
      this._log(blk, `🔍 影响评估：${nd} 条物资派发、${nb} 个转移批次受影响`)
    },

    /* ---------- 指挥员确认影响 → 生成绕行/改派方案 ---------- */

    confirmImpacts(blockId) {
      const blk = this._block(blockId)
      if (!blk) return
      blk.impacts.forEach((imp) => {
        if (imp.checked && !imp.done) {
          imp.options = this._optionsFor(blk, imp)
          imp.plan = imp.options[0] || null // 默认推荐：绕行优先，其次改派，兜底挂起
        }
      })
      blk.confirmed = true
      const n = blk.impacts.filter((i) => i.checked).length
      this._log(blk, `✔️ 指挥员确认 ${n} 项影响，已生成绕行/改派方案`)
      // 回写受影响事件时间线
      const cmd = this._cmd()
      const tr = this._tr()
      const evIds = new Set()
      blk.impacts.filter((i) => i.checked).forEach((i) => {
        if (i.kind === 'dispatch') {
          const d = cmd.dispatches.find((x) => x.id === i.id)
          if (d?.eventId) evIds.add(d.eventId)
        } else {
          const b = tr.batches.find((x) => x.id === i.id)
          if (b) evIds.add(b.eventId)
        }
      })
      evIds.forEach((id) => {
        const ev = cmd.events.find((e) => e.id === id)
        if (ev) ev.timeline.push({ at: nowStr(), text: `🚧 道路阻断「${blk.name}」生效，相关派发/转移任务已生成绕行或改派方案` })
      })
    },

    // 单个影响对象的候选方案：绕行 → 改派 → 挂起（目的地/出发地在封闭区内时不可绕行）
    _optionsFor(blk, imp) {
      const cmd = this._cmd()
      const tr = this._tr()
      const opts = []
      const polys = this.activePolygons
      if (imp.kind === 'dispatch') {
        const d = cmd.dispatches.find((x) => x.id === imp.id)
        if (!d) return opts
        if (!imp.destInside) {
          const base = cmd.bases.find((b) => b.id === d.baseId)
          const det = detourPath([base.lng, base.lat], [d.lng, d.lat], blk.polygon)
          if (det) {
            const m = pathMetrics([[base.lng, base.lat], ...det.via, [d.lng, d.lat]])
            opts.push({
              action: 'detour', via: det.via, distance: m.distance, minutes: m.minutes,
              label: `绕行 +${(m.distance - d.distance).toFixed(1)}km·+${m.minutes - d.minutes}min`
            })
          }
          // 改派基地：库存足够且新路线不穿越任何生效阻断
          const alt = cmd.bases
            .filter((b) => b.id !== d.baseId && (b.stock[d.type] || 0) >= d.qty)
            .filter((b) => !polys.some((p) => pathBlocked([[b.lng, b.lat], [d.lng, d.lat]], p)))
            .map((b) => ({ b, m: pathMetrics([[b.lng, b.lat], [d.lng, d.lat]]) }))
            .sort((x, y) => x.m.minutes - y.m.minutes)[0]
          if (alt) {
            opts.push({
              action: 'reassign', baseId: alt.b.id, baseName: alt.b.name,
              distance: alt.m.distance, minutes: alt.m.minutes,
              label: `改派自「${alt.b.name}」 ${alt.m.distance}km·${alt.m.minutes}min`
            })
          }
        }
        opts.push({ action: 'suspend', label: imp.destInside ? '目的地在封闭区内 · 挂起待通（物资退回基地）' : '挂起待通（物资退回基地）' })
      } else {
        const b = tr.batches.find((x) => x.id === imp.id)
        if (!b) return opts
        const ev = cmd.events.find((e) => e.id === b.eventId)
        if (!ev) return opts
        if (!imp.destInside && !imp.originInside) {
          const sh = tr.shelters.find((s) => s.id === b.shelterId)
          const det = detourPath([ev.location.lng, ev.location.lat], [sh.lng, sh.lat], blk.polygon)
          if (det) {
            const m = pathMetrics([[ev.location.lng, ev.location.lat], ...det.via, [sh.lng, sh.lat]])
            const cur = b.eta || pathMetrics([[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]])
            opts.push({
              action: 'detour', via: det.via, distance: m.distance, minutes: m.minutes,
              label: `绕行 +${(m.distance - cur.distance).toFixed(1)}km·+${m.minutes - cur.minutes}min`
            })
          }
        }
        if (!imp.originInside) {
          // 改派安置点：床位足够且新路线不穿越任何生效阻断
          const alt = tr.shelters
            .filter((s) => s.id !== b.shelterId && tr.bedMap[s.id].left >= b.headcount)
            .filter((s) => !polys.some((p) => pathBlocked([[ev.location.lng, ev.location.lat], [s.lng, s.lat]], p)))
            .map((s) => ({ s, m: pathMetrics([[ev.location.lng, ev.location.lat], [s.lng, s.lat]]) }))
            .sort((x, y) => x.m.minutes - y.m.minutes)[0]
          if (alt) {
            opts.push({
              action: 'reassign', shelterId: alt.s.id, shelterName: alt.s.name,
              distance: alt.m.distance, minutes: alt.m.minutes,
              label: `改派至「${alt.s.name}」 ${alt.m.distance}km·${alt.m.minutes}min`
            })
          }
        }
        opts.push({ action: 'suspend', label: '挂起待通（保留车辆/床位预占）' })
      }
      return opts
    },

    /* ---------- 执行方案：同步路线、到达时间与车辆床位占用 ---------- */

    applyImpact(blockId, key) {
      const blk = this._block(blockId)
      const imp = blk?.impacts.find((i) => i.key === key)
      if (!blk || !imp || imp.done || !imp.plan) return { ok: false, msg: '无待执行方案' }
      const cmd = this._cmd()
      const tr = this._tr()
      const p = imp.plan
      let ok = true, msg = ''
      if (imp.kind === 'dispatch') {
        if (p.action === 'detour') {
          cmd.rerouteDispatch(imp.id, p.via, blk.id)
          msg = `派发已绕行改道（${p.distance}km·${p.minutes}min）`
        } else if (p.action === 'reassign') {
          ok = !!cmd.reassignDispatch(imp.id, p.baseId)
          msg = ok ? `派发已改派自 ${p.baseName}` : '改派失败：目标基地库存不足'
        } else {
          cmd.holdDispatch(imp.id, blk.id)
          msg = '派发已挂起，物资退回基地'
        }
      } else {
        if (p.action === 'detour') {
          tr.rerouteBatch(imp.id, p.via, blk.id)
          msg = `批次已绕行改道（${p.distance}km·${p.minutes}min）`
        } else if (p.action === 'reassign') {
          const r = tr.reassignBatch(imp.id, { shelterId: p.shelterId })
          ok = r.ok
          msg = ok ? `批次已改派至 ${p.shelterName}（车辆/床位占用已同步）` : r.msg
        } else {
          tr.holdBatch(imp.id, blk.id)
          msg = '批次已挂起（保留车辆/床位预占）'
        }
      }
      if (!ok) return { ok, msg }
      imp.done = true
      imp.result = { action: p.action, msg }
      this._log(blk, `✅ ${msg}`)
      return { ok: true, msg }
    },

    applyAll(blockId) {
      const blk = this._block(blockId)
      if (!blk) return 0
      let n = 0
      blk.impacts.filter((i) => i.checked && !i.done && i.plan).forEach((i) => {
        if (this.applyImpact(blockId, i.key).ok) n++
      })
      return n
    },

    /* ---------- 恢复通行 → 挂起任务续派 ---------- */

    clearBlock(blockId) {
      const blk = this._block(blockId)
      if (!blk || blk.status !== 'active') return
      blk.status = 'cleared'
      blk.clearedAt = nowStr()
      this._log(blk, '✅ 道路恢复通行')
      // 因本阻断绕行的任务恢复直线（前提：直线不再穿越其它生效阻断）
      const cmd = this._cmd()
      const tr = this._tr()
      const polys = this.activePolygons
      let restored = 0
      cmd.dispatches.forEach((d) => {
        if (d.detourBy !== blockId || d.status === 'held') return
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) return
        const straight = [[base.lng, base.lat], [d.lng, d.lat]]
        if (!polys.some((p) => pathBlocked(straight, p))) {
          cmd.resetDispatchRoute(d.id)
          restored++
        }
      })
      tr.batches.forEach((b) => {
        if (b.detourBy !== blockId || b.status === 'closed') return
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) return
        const straight = [[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]]
        if (!polys.some((p) => pathBlocked(straight, p))) {
          tr.resetBatchRoute(b.id)
          restored++
        }
      })
      if (restored) this._log(blk, `↩️ ${restored} 条绕行路线恢复直线`)
    },

    // 一键续派：挂起任务逐个复核路线（仍被其它生效阻断穿越的保持挂起）
    resumeHeld() {
      const cmd = this._cmd()
      const tr = this._tr()
      const polys = this.activePolygons
      const destBlocked = (lng, lat) => polys.some((p) => pointInPolygon([lng, lat], p))
      let resumed = 0, kept = 0, failed = 0
      cmd.dispatches.filter((d) => d.status === 'held').forEach((d) => {
        const base = cmd.bases.find((b) => b.id === d.baseId)
        if (!base) { kept++; return }
        const straight = [[base.lng, base.lat], [d.lng, d.lat]]
        if (destBlocked(d.lng, d.lat) || polys.some((p) => pathBlocked(straight, p))) { kept++; return }
        if (cmd.resumeDispatch(d.id).ok) resumed++
        else failed++
      })
      tr.batches.filter((b) => b.held).forEach((b) => {
        const ev = cmd.events.find((e) => e.id === b.eventId)
        const sh = tr.shelters.find((s) => s.id === b.shelterId)
        if (!ev || !sh) { kept++; return }
        const straight = [[ev.location.lng, ev.location.lat], [sh.lng, sh.lat]]
        if (destBlocked(sh.lng, sh.lat) || polys.some((p) => pathBlocked(straight, p))) { kept++; return }
        tr.resumeBatch(b.id)
        resumed++
      })
      return { resumed, kept, failed }
    },

    // 删除已恢复的历史阻断记录
    removeBlock(id) {
      const blk = this._block(id)
      if (!blk || blk.status !== 'cleared') return
      this.blocks = this.blocks.filter((b) => b.id !== id)
      if (this.selectedBlockId === id) this.selectedBlockId = null
    }
  }
})
