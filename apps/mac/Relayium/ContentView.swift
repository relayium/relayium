import SwiftUI
import RelayiumKit

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Relayium")
                .font(.title)
            Text(RelayiumKit.sodiumReady() ? "core ready" : "core FAILED")
        }
        .padding()
        .frame(minWidth: 300, minHeight: 150)
    }
}

#Preview {
    ContentView()
}
