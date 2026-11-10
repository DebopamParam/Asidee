{
  description = "Paddock: sandboxes for coding agents that are checked, not assumed";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  # Optional. Paddock only needs Bun to run from source; this shell is one way to get it.
  outputs = { self, nixpkgs }:
    let systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
    in {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { packages = [ pkgs.bun ]; }; });
    };
}
