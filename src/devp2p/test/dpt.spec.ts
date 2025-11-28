import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '../../utils'

import { DPT } from '../dpt/index.ts'

import type { PeerInfo } from '../types.ts'

describe('DPT', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const privateKey1 = hexToBytes(
    '0x012e930448c53e0b73edbbbc433e8a741e978cda79be2be039905f538d6247c2',
  )

  const peers: PeerInfo[] = []

  for (let i = 1; i <= 5; i++) {
    const id = new Uint8Array([i])
    const address = '127.0.0.1'
    const udpPort = 5000 + i
    const peer: PeerInfo = {
      id,
      address,
      udpPort,
    }
    peers.push(peer)
  }

  // Mock transport class for testing
  class MockTransport {
    events = {
      once: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    }
    ping = vi.fn()
    findneighbours = vi.fn()
    bind = vi.fn()
    destroy = vi.fn()
  }

  it('should initialize and add peers', async () => {
    const dpt = new DPT(privateKey1, {})
    // Stop the automatic refresh intervals before replacing the transport
    clearInterval(dpt['_kad']['_refreshIntervalId'])
    clearInterval(dpt['_refreshIntervalId'])
    
    // Replace the transport with mock
    const mockTransport = new MockTransport() as any
    dpt['_kad']['_transport'] = mockTransport
    
    assert.strictEqual(dpt['_dnsAddr'], '8.8.8.8', 'should initialize with default values')

    mockTransport.ping = vi.fn().mockResolvedValue(peers[0])
    await dpt.bootstrap(peers[0])
    assert.strictEqual(dpt.numPeers(), 1, 'should add peer on bootstrap()')

    // Attention! Not all peers are called by default in refresh()
    // (take into account on test design)
    // bootstrap() calls findneighbours once, and refresh() calls it once
    const spy = vi.spyOn(mockTransport, 'findneighbours')
    await dpt.refresh()
    expect(spy).toHaveBeenCalled()

    mockTransport.ping = vi.fn().mockResolvedValue(peers[1])
    await dpt.addPeer(peers[1])
    assert.strictEqual(dpt.numPeers(), 2, 'should add another peer on addPeer()')

    assert.strictEqual(
      dpt.getClosestPeers(peers[0].id!).length,
      2,
      'should return all peers on getClosestPeers()',
    )

    dpt.destroy()
  })

  it('should only call to confirmed peers on activated flag', async () => {
    const dpt = new DPT(privateKey1, { onlyConfirmed: true })
    // Stop the automatic refresh intervals before replacing the transport
    clearInterval(dpt['_kad']['_refreshIntervalId'])
    clearInterval(dpt['_refreshIntervalId'])
    
    // Replace the transport with mock
    const mockTransport = new MockTransport() as any
    dpt['_kad']['_transport'] = mockTransport

    mockTransport.ping = vi.fn().mockResolvedValue(peers[0])
    await dpt.addPeer(peers[0])

    const spy = vi.spyOn(mockTransport, 'findneighbours')
    await dpt.refresh()
    expect(
      spy,
      'call findneighbours on unconfirmed if no confirmed peers yet',
    ).toHaveBeenCalledTimes(1)

    dpt['_kad']['_refreshIntervalSelectionCounter'] = 0
    dpt.confirmPeer('01')
    await dpt.refresh()
    expect(spy, 'call findneighbours on confirmed').toHaveBeenCalledTimes(2)

    mockTransport.ping = vi.fn().mockResolvedValue(peers[1])
    await dpt.addPeer(peers[1])
    assert.strictEqual(
      dpt.getClosestPeers(peers[0].id!).length,
      1,
      'should not return unconfirmed on getClosestPeers()',
    )

    dpt.confirmPeer('02')
    assert.strictEqual(
      dpt.getClosestPeers(peers[0].id!).length,
      2,
      'should return confirmed on getClosestPeers()',
    )

    dpt.removePeer(peers[1])
    assert.strictEqual(
      dpt.getClosestPeers(peers[0].id!).length,
      1,
      'should work after peers being removed',
    )

    dpt.destroy()
  })
})
