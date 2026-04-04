interface Locale {
  agents: {
    rotateKey: {
      title: string
      confirmBody: string
      rotating: string
    }
    deleteAgent: {
      title: string
      deleting: string
    }
    form: {
      editCapabilities: string
    }
  }
  common: {
    done: string
  }
}

const en = require('../../i18n/locales/en.json') as Locale
const zh = require('../../i18n/locales/zh.json') as Locale

describe('i18n locale parity', () => {
  describe('agents.rotateKey key parity', () => {
    it('has agents.rotateKey.title in zh.json when en.json has it', () => {
      expect(en.agents.rotateKey.title).toBeDefined()
      expect(zh.agents.rotateKey.title).toBeDefined()
      expect(zh.agents.rotateKey.title).toBeTruthy()
    })

    it('has agents.rotateKey.confirmBody in zh.json when en.json has it', () => {
      expect(en.agents.rotateKey.confirmBody).toBeDefined()
      expect(zh.agents.rotateKey.confirmBody).toBeDefined()
      expect(zh.agents.rotateKey.confirmBody).toBeTruthy()
    })

    it('has agents.rotateKey.rotating in zh.json when en.json has it', () => {
      expect(en.agents.rotateKey.rotating).toBeDefined()
      expect(zh.agents.rotateKey.rotating).toBeDefined()
      expect(zh.agents.rotateKey.rotating).toBeTruthy()
    })
  })

  describe('agents.deleteAgent key parity', () => {
    it('has agents.deleteAgent.title in zh.json when en.json has it', () => {
      expect(en.agents.deleteAgent.title).toBeDefined()
      expect(zh.agents.deleteAgent.title).toBeDefined()
      expect(zh.agents.deleteAgent.title).toBeTruthy()
    })

    it('has agents.deleteAgent.deleting in zh.json when en.json has it', () => {
      expect(en.agents.deleteAgent.deleting).toBeDefined()
      expect(zh.agents.deleteAgent.deleting).toBeDefined()
      expect(zh.agents.deleteAgent.deleting).toBeTruthy()
    })
  })

  describe('common.done key parity', () => {
    it('has common.done in zh.json when en.json has it', () => {
      expect(en.common.done).toBeDefined()
      expect(zh.common.done).toBeDefined()
      expect(zh.common.done).toBeTruthy()
    })
  })

  describe('agents.form.editCapabilities key parity', () => {
    it('has agents.form.editCapabilities in zh.json when en.json has it', () => {
      expect(en.agents.form.editCapabilities).toBeDefined()
      expect(zh.agents.form.editCapabilities).toBeDefined()
      expect(zh.agents.form.editCapabilities).toBeTruthy()
    })
  })
})
