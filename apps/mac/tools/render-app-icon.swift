// Renders apps/mac/Brand/AppIcon.svg into a macOS `.appiconset`.
//
//   xcrun swift apps/mac/tools/render-app-icon.swift \
//     apps/mac/Relayium/Assets.xcassets/AppIcon.appiconset
//
// Run BY HAND. Nothing in CI, in `xcodebuild` or in `swift test` runs this
// script — see tools/README.md for why. Only Foundation, CoreGraphics and
// ImageIO, all system frameworks, so any machine that can build this app can
// run it.
//
// Every geometric and colour constant is READ OUT OF THE SVG rather than
// duplicated here. That is the point of the file: the artwork is written down
// exactly once, so a change to the SVG cannot silently disagree with a Swift
// constant that renders it.

import CoreGraphics
import Foundation
import ImageIO

// MARK: - Where things are

/// The script resolves its inputs against its own location, so the command
/// works from any working directory.
let scriptDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let artworkURL = scriptDirectory
    .deletingLastPathComponent()            // apps/mac
    .appendingPathComponent("Brand/AppIcon.svg")

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("""
        usage: xcrun swift render-app-icon.swift <AppIcon.appiconset path>

        """.utf8))
    exit(2)
}
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[1])

func fail(_ message: String) -> Never {
    fatalError("render-app-icon: \(message)")
}

// MARK: - The smallest XML reader that can read this one file

/// The SVG with comments removed, so a `=` or a `<` inside prose can never be
/// mistaken for markup.
let svg: String = {
    guard var text = try? String(contentsOf: artworkURL, encoding: .utf8) else {
        fail("cannot read \(artworkURL.path)")
    }
    while let open = text.range(of: "<!--"), let close = text.range(of: "-->", range: open.upperBound..<text.endIndex) {
        text.removeSubrange(open.lowerBound..<close.upperBound)
    }
    return text
}()

/// Every `name="value"` pair in one element's opening tag.
func parseAttributes(_ s: Substring) -> [String: String] {
    var result: [String: String] = [:]
    var i = s.startIndex
    while i < s.endIndex {
        guard let nameStart = s[i...].firstIndex(where: { $0.isLetter }) else { break }
        var j = nameStart
        while j < s.endIndex, s[j].isLetter || s[j].isNumber || s[j] == "-" || s[j] == ":" {
            j = s.index(after: j)
        }
        let name = String(s[nameStart..<j])
        var k = j
        while k < s.endIndex, s[k].isWhitespace { k = s.index(after: k) }
        guard k < s.endIndex, s[k] == "=" else { i = j; continue }
        k = s.index(after: k)
        while k < s.endIndex, s[k].isWhitespace { k = s.index(after: k) }
        guard k < s.endIndex, s[k] == "\"" else { i = k; continue }
        let valueStart = s.index(after: k)
        guard let valueEnd = s[valueStart...].firstIndex(of: "\"") else { break }
        result[name] = String(s[valueStart..<valueEnd])
        i = s.index(after: valueEnd)
    }
    return result
}

struct Element {
    let attributes: [String: String]
    /// Index just past this element's `>`, i.e. where its content begins.
    let contentStart: String.Index
}

/// Every `<name …>` opening tag in `text`, in document order.
func elements(named name: String, in text: Substring) -> [Element] {
    var found: [Element] = []
    var cursor = text.startIndex
    while let open = text.range(of: "<\(name)", range: cursor..<text.endIndex) {
        cursor = open.upperBound
        // "<g" must not match "<gradientStop"; the next character has to end the name.
        guard cursor == text.endIndex || text[cursor].isWhitespace || text[cursor] == ">" || text[cursor] == "/" else {
            continue
        }
        guard let close = text[cursor...].firstIndex(of: ">") else { break }
        found.append(Element(attributes: parseAttributes(text[cursor..<close]),
                             contentStart: text.index(after: close)))
        cursor = text.index(after: close)
    }
    return found
}

func number(_ raw: String?, _ what: String) -> CGFloat {
    guard let raw, let value = Double(raw) else { fail("\(what) is missing or not a number") }
    return CGFloat(value)
}

/// `#rgb` or `#rrggbb`, plus a separate opacity, as sRGB.
func color(hex: String, opacity: String?) -> CGColor {
    var digits = Array(hex.drop { $0 == "#" })
    if digits.count == 3 { digits = digits.flatMap { [$0, $0] } }
    guard digits.count == 6, let packed = Int(String(digits), radix: 16) else {
        fail("unsupported colour '\(hex)'")
    }
    let alpha = opacity.flatMap(Double.init) ?? 1
    return CGColor(srgbRed: CGFloat((packed >> 16) & 0xFF) / 255,
                   green: CGFloat((packed >> 8) & 0xFF) / 255,
                   blue: CGFloat(packed & 0xFF) / 255,
                   alpha: CGFloat(alpha))
}

/// Every number in a string, in order — used for `viewBox` and `transform`.
func numbers(in s: String) -> [CGFloat] {
    var found: [CGFloat] = []
    var digits = ""
    func flush() {
        if !digits.isEmpty, let v = Double(digits) { found.append(CGFloat(v)) }
        digits = ""
    }
    for c in s {
        if c.isNumber || c == "." || c == "-" || c == "+" { digits.append(c) } else { flush() }
    }
    flush()
    return found
}

// MARK: - The artwork, read out of the SVG

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

guard let root = elements(named: "svg", in: svg[...]).first else { fail("no <svg> element") }
let canvas = numbers(in: root.attributes["viewBox"] ?? "")
guard canvas.count == 4, canvas[2] == canvas[3] else { fail("viewBox must be a square") }
let canvasEdge = canvas[2]

struct Gradient {
    let start: CGPoint
    let end: CGPoint
    let gradient: CGGradient
}

func gradient(id: String) -> Gradient {
    // Each `</linearGradient>` closes the one opened in the same chunk, so a
    // chunk carries exactly one gradient and its own stops.
    for chunk in svg.components(separatedBy: "</linearGradient>") {
        guard let element = elements(named: "linearGradient", in: chunk[...]).first,
              element.attributes["id"] == id else { continue }
        guard element.attributes["gradientUnits"] == "userSpaceOnUse" else {
            fail("gradient '\(id)' must be userSpaceOnUse")
        }
        var colors: [CGColor] = []
        var locations: [CGFloat] = []
        for stop in elements(named: "stop", in: chunk[element.contentStart...]) {
            colors.append(color(hex: stop.attributes["stop-color"] ?? "",
                                opacity: stop.attributes["stop-opacity"]))
            locations.append(number(stop.attributes["offset"], "stop offset in '\(id)'"))
        }
        guard colors.count >= 2,
              let cg = CGGradient(colorsSpace: sRGB, colors: colors as CFArray, locations: locations)
        else { fail("gradient '\(id)' needs at least two stops") }
        return Gradient(
            start: CGPoint(x: number(element.attributes["x1"], "x1 of '\(id)'"),
                           y: number(element.attributes["y1"], "y1 of '\(id)'")),
            end: CGPoint(x: number(element.attributes["x2"], "x2 of '\(id)'"),
                         y: number(element.attributes["y2"], "y2 of '\(id)'")),
            gradient: cg)
    }
    fail("no <linearGradient id=\"\(id)\">")
}

let bodyGradient = gradient(id: "body")
let sheenGradient = gradient(id: "sheen")

// The body and the sheen are two rects of identical geometry, and this renderer
// clips both gradients to one shape. Checking that they really are identical
// keeps that shortcut honest: a future SVG whose second rect diverged would
// otherwise be rendered with the second rect silently ignored.
let rectElements = elements(named: "rect", in: svg[...])
let rectGeometry = rectElements.map { element in
    ["x", "y", "width", "height", "rx"].map { element.attributes[$0] ?? "" }
}
guard let bodyRectElement = rectElements.first else { fail("no <rect>") }
guard Set(rectGeometry.map { $0.joined(separator: " ") }).count == 1 else {
    fail("every <rect> must share one geometry; this renderer clips to a single body shape")
}
let bodyRect = CGRect(x: number(bodyRectElement.attributes["x"], "body x"),
                      y: number(bodyRectElement.attributes["y"], "body y"),
                      width: number(bodyRectElement.attributes["width"], "body width"),
                      height: number(bodyRectElement.attributes["height"], "body height"))
let cornerRadius = number(bodyRectElement.attributes["rx"], "body rx")

guard let glyphGroup = elements(named: "g", in: svg[...]).first,
      let transform = glyphGroup.attributes["transform"],
      let translateRange = transform.range(of: "translate("),
      let translateEnd = transform[translateRange.upperBound...].firstIndex(of: ")"),
      let scaleRange = transform.range(of: "scale("),
      let scaleEnd = transform[scaleRange.upperBound...].firstIndex(of: ")")
else { fail("the glyph group needs transform=\"translate(x y) scale(s)\"") }
let translation = numbers(in: String(transform[translateRange.upperBound..<translateEnd]))
let scaleValues = numbers(in: String(transform[scaleRange.upperBound..<scaleEnd]))
guard translation.count == 2, scaleValues.count == 1 else { fail("unsupported glyph transform") }

guard let glyphElement = elements(named: "path", in: svg[...]).first,
      let commands = glyphElement.attributes["d"]
else { fail("no <path d=…>") }
let glyphColor = color(hex: glyphElement.attributes["stroke"] ?? "", opacity: nil)
let glyphStrokeWidth = number(glyphElement.attributes["stroke-width"], "stroke-width")
guard glyphElement.attributes["stroke-linecap"] == "round",
      glyphElement.attributes["stroke-linejoin"] == "round"
else { fail("the glyph must use round caps and joins") }

// MARK: - The SVG path subset this `d` actually uses

/// Supports exactly `M`, `h`, `H`, `l`, and the implicit absolute `L` that SVG
/// defines for extra coordinate pairs after an `M`.
///
/// Anything else is a `fatalError` rather than a skip, deliberately: a silently
/// ignored command would render a *partial* glyph, and a partial glyph is the
/// kind of thing that ships.
func parsePath(_ d: String) -> CGPath {
    enum Token { case command(Character), number(CGFloat) }
    var tokens: [Token] = []
    var digits = ""
    func flushNumber() {
        if !digits.isEmpty {
            guard let v = Double(digits) else { fail("'\(digits)' is not a number in the path") }
            tokens.append(.number(CGFloat(v)))
            digits = ""
        }
    }
    for c in d {
        if c.isNumber || c == "." {
            digits.append(c)
        } else if c == "-" || c == "+" {
            flushNumber()                       // a sign always starts a new number
            digits.append(c)
        } else if c.isLetter {
            flushNumber()
            tokens.append(.command(c))
        } else if c == " " || c == "," || c.isWhitespace {
            flushNumber()
        } else {
            fail("unexpected character '\(c)' in the path")
        }
    }
    flushNumber()

    let path = CGMutablePath()
    var point = CGPoint.zero
    var index = 0
    var previous: Character?
    func nextNumber(_ command: Character) -> CGFloat {
        guard index < tokens.count, case .number(let v) = tokens[index] else {
            fail("command '\(command)' ran out of numbers")
        }
        index += 1
        return v
    }
    while index < tokens.count {
        var command: Character
        if case .command(let c) = tokens[index] {
            command = c
            index += 1
        } else {
            // A bare coordinate pair continues the previous command. SVG says
            // that repeating an `M` means `L`, which is the only implicit form
            // this artwork uses; anything else would be a guess.
            guard previous == "M" || previous == "L" else {
                fail("a coordinate pair may only follow M or L, not '\(previous.map(String.init) ?? "nothing")'")
            }
            command = "L"
        }
        switch command {
        case "M":
            point = CGPoint(x: nextNumber("M"), y: nextNumber("M"))
            path.move(to: point)
        case "L":
            point = CGPoint(x: nextNumber("L"), y: nextNumber("L"))
            path.addLine(to: point)
        case "H":
            point = CGPoint(x: nextNumber("H"), y: point.y)
            path.addLine(to: point)
        case "h":
            point = CGPoint(x: point.x + nextNumber("h"), y: point.y)
            path.addLine(to: point)
        case "l":
            point = CGPoint(x: point.x + nextNumber("l"), y: point.y + nextNumber("l"))
            path.addLine(to: point)
        default:
            fail("unsupported SVG path command '\(command)' — teach this parser before using it")
        }
        previous = command
    }
    return path
}

let glyphPath = parsePath(commands)

// MARK: - Rasterization

func render(edge: Int) -> CGImage {
    guard let context = CGContext(
        data: nil, width: edge, height: edge, bitsPerComponent: 8, bytesPerRow: 0,
        space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fail("cannot create a \(edge)px context") }
    context.setShouldAntialias(true)

    // The SVG's y grows downward and a CGContext's grows upward: one flip, then
    // one uniform scale, and every number below is a literal from AppIcon.svg.
    context.translateBy(x: 0, y: CGFloat(edge))
    context.scaleBy(x: 1, y: -1)
    let scale = CGFloat(edge) / canvasEdge
    context.scaleBy(x: scale, y: scale)

    let body = CGPath(roundedRect: bodyRect, cornerWidth: cornerRadius,
                      cornerHeight: cornerRadius, transform: nil)
    // Body first, then the sheen over it — the SVG's own painting order.
    for fill in [bodyGradient, sheenGradient] {
        context.saveGState()
        context.addPath(body)
        context.clip()
        context.drawLinearGradient(fill.gradient, start: fill.start, end: fill.end,
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        context.restoreGState()
    }

    context.saveGState()
    context.translateBy(x: translation[0], y: translation[1])
    context.scaleBy(x: scaleValues[0], y: scaleValues[0])
    context.addPath(glyphPath)
    context.setStrokeColor(glyphColor)
    context.setLineWidth(glyphStrokeWidth)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.strokePath()
    context.restoreGState()

    guard let image = context.makeImage() else { fail("cannot snapshot the \(edge)px context") }
    return image
}

// MARK: - The ten macOS slots over seven PNGs

/// macOS — unlike iOS — wants an asset for every size rather than deriving them
/// from one large image, so 16/32/128/256/512 each appear at 1× and 2×, and
/// 32, 256 and 512 are therefore each referenced twice.
/// https://developer.apple.com/documentation/xcode/configuring-your-app-icon/
let slots: [(point: Int, scale: Int)] = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
                                         (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
func filename(forPixels pixels: Int) -> String { "icon_\(pixels).png" }

try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

for pixels in Set(slots.map { $0.point * $0.scale }).sorted() {
    let url = outputDirectory.appendingPathComponent(filename(forPixels: pixels))
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, "public.png" as CFString, 1, nil)         // the PNG UTI, no extra import
    else { fail("cannot write \(url.path)") }
    CGImageDestinationAddImage(destination, render(edge: pixels), nil)
    guard CGImageDestinationFinalize(destination) else { fail("cannot finalize \(url.path)") }
    print("wrote \(url.path)")
}

// Hand-built rather than JSONSerialization so the key order is stable and the
// file stays reviewable as a diff.
let entries = slots.map { slot in
    """
        {
          "idiom" : "mac",
          "size" : "\(slot.point)x\(slot.point)",
          "scale" : "\(slot.scale)x",
          "filename" : "\(filename(forPixels: slot.point * slot.scale))"
        }
    """
}
let contents = """
{
  "images" : [
\(entries.joined(separator: ",\n"))
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}

"""
let contentsURL = outputDirectory.appendingPathComponent("Contents.json")
do { try contents.write(to: contentsURL, atomically: true, encoding: .utf8) }
catch { fail("cannot write \(contentsURL.path): \(error)") }
print("wrote \(contentsURL.path)")
