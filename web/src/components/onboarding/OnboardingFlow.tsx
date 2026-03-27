import { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useModuleStore } from '../../stores/moduleStore'
import { getOptionalModules, getAllModules } from '../../modules/registry'
import { Toggle } from '../common/Toggle'
import s from './OnboardingFlow.module.css'

const questions = [
  { emoji: '\u{1F44B}', text: '你希望怎么称呼你？', placeholder: '输入你的名字...' },
  { emoji: '\u{1F4BC}', text: '你从事什么工作？', placeholder: '比如：会计、设计师、产品经理...' },
  { emoji: '\u2728', text: '你希望泡泡帮你做什么？', placeholder: '比如：记住重要信息、管理日程...' },
]

// Total steps = questions + 1 (module selection)
const TOTAL_STEPS = questions.length + 1

interface Props {
  onComplete: () => void
}

export function OnboardingFlow({ onComplete }: Props) {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[]>([])
  const [expandedStep, setExpandedStep] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showModuleStep, setShowModuleStep] = useState(false)
  const [selectedModules, setSelectedModules] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const status = useChatStore((s) => s.status)
  const setModules = useModuleStore((s) => s.setModules)

  useEffect(() => {
    if (expandedStep !== null) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [expandedStep])

  const handleBubbleClick = (index: number) => {
    if (index !== step || expandedStep !== null) return
    setExpandedStep(index)
  }

  const finishOnboarding = (moduleIds: string[]) => {
    setSending(true)
    const composed = `你好泡泡，我叫${answers[0]}，我是做${answers[1]}的，希望你帮我${answers[2]}`

    // Save module preferences
    const coreIds = getAllModules().filter(m => m.locked).map(m => m.id)
    setModules([...coreIds, ...moduleIds])

    setTimeout(() => {
      sendMessage(composed)
      localStorage.setItem('bubble_onboarding_done', 'true')
      setTimeout(() => onComplete(), 1500)
    }, 400)
  }

  const handleSubmit = () => {
    const trimmed = input.trim()
    if (!trimmed) return

    const newAnswers = [...answers, trimmed]
    setAnswers(newAnswers)
    setInput('')
    setExpandedStep(null)

    if (newAnswers.length >= questions.length) {
      // All questions answered — show module selection step
      setTimeout(() => setShowModuleStep(true), 400)
    } else {
      setTimeout(() => setStep(newAnswers.length), 400)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const toggleOptionalModule = (id: string) => {
    setSelectedModules(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (sending) {
    return (
      <div className={s.container}>
        <div className={s.completion}>
          <div className={s.completionText}>泡泡正在记住你...</div>
          <div className={s.dots}>
            <div className={s.dot} />
            <div className={s.dot} />
            <div className={s.dot} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={s.container}>
      <div className={s.welcomeTitle}>欢迎来到 Bubble Agent</div>
      <div className={s.bubbles}>
        {questions.map((q, i) => {
          if (i > step) return null
          const isAnswered = i < answers.length
          const isExpanded = expandedStep === i
          const cls = [s.bubble, isExpanded && s.expanded, isAnswered && s.answered].filter(Boolean).join(' ')

          return (
            <div key={i} className={cls} onClick={() => handleBubbleClick(i)}>
              <div className={s.emoji}>{q.emoji}</div>
              <div className={s.questionText}>{q.text}</div>
              {isAnswered && <div className={s.answerPreview}>{answers[i]}</div>}
              <div className={`${s.inputArea} ${isExpanded ? s.visible : ''}`}>
                <input
                  ref={i === step ? inputRef : undefined}
                  className={s.input}
                  type="text"
                  placeholder={q.placeholder}
                  value={isExpanded ? input : ''}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <div className={s.actions}>
                  <button
                    className={s.submitBtn}
                    onClick={(e) => { e.stopPropagation(); handleSubmit() }}
                    disabled={!input.trim() || status !== 'connected'}
                  >
                    {status !== 'connected' ? '连接中...' : '确认'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {/* Module selection step */}
        {showModuleStep && (
          <div className={`${s.bubble} ${s.expanded} ${s.moduleStep}`}>
            <div className={s.emoji}>{'\u{1F9E9}'}</div>
            <div className={s.questionText}>选择你需要的功能</div>

            <div className={s.moduleList}>
              {/* Core modules — always on */}
              {getAllModules().filter(m => m.locked).map(m => (
                <div key={m.id} className={s.moduleItem}>
                  <span className={s.moduleLabel}>{m.tab.label}</span>
                  <span className={s.moduleLocked}>必选</span>
                  <Toggle checked disabled onChange={() => {}} />
                </div>
              ))}

              {/* Optional modules */}
              {getOptionalModules().map(m => (
                <div key={m.id} className={s.moduleItem}>
                  <div className={s.moduleInfo}>
                    <span className={s.moduleEmoji}>{m.onboarding?.emoji}</span>
                    <div>
                      <span className={s.moduleLabel}>{m.onboarding?.title || m.tab.label}</span>
                      {m.onboarding?.description && (
                        <span className={s.moduleDesc}>{m.onboarding.description}</span>
                      )}
                    </div>
                  </div>
                  <Toggle
                    checked={selectedModules.has(m.id)}
                    onChange={() => toggleOptionalModule(m.id)}
                  />
                </div>
              ))}
            </div>

            <div className={s.moduleActions}>
              <button
                className={s.skipBtn}
                onClick={() => finishOnboarding([])}
              >
                以后再说
              </button>
              <button
                className={s.submitBtn}
                onClick={() => finishOnboarding([...selectedModules])}
                disabled={status !== 'connected'}
              >
                {status !== 'connected' ? '连接中...' : '确认'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
