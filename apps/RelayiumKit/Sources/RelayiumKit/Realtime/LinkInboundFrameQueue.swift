/// The file driver's disk-wait FIFO. Its caller owns synchronization and the
/// frame/byte admission limits; this type only stores frames in wire order.
///
/// Removing an Array's first element shifts every remaining frame while the
/// driver holds its state lock. A ring releases the consumed payload immediately
/// and leaves the remaining frames in place. Capacity grows geometrically with
/// peak occupancy (minimum eight slots), never with total transferred bytes.
struct LinkInboundFrameQueue<Element> {
    private var slots: [Element?] = []
    private var head = 0
    private(set) var count = 0

    var isEmpty: Bool { count == 0 }
    var capacity: Int { slots.count }

    mutating func append(_ element: Element) {
        if count == slots.count {
            var grown = [Element?](repeating: nil, count: max(8, slots.count * 2))
            for i in 0..<count {
                grown[i] = slots[(head + i) % slots.count]
            }
            slots = grown
            head = 0
        }
        slots[(head + count) % slots.count] = .some(element)
        count += 1
    }

    mutating func removeFirst() -> Element {
        precondition(!isEmpty)
        let element = slots[head]!
        slots[head] = nil
        count -= 1
        head = count == 0 ? 0 : (head + 1) % slots.count
        return element
    }
}
