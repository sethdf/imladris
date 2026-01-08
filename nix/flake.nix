{
  description = "DevBox - Cloud development workstation";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, home-manager, ... }:
    let
      # Support both architectures
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

      # Helper to get pkgs for a system
      pkgsFor = system: import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };
    in
    {
      # Home-manager configurations
      homeConfigurations = {
        # Default ubuntu user (EC2)
        "ubuntu" = home-manager.lib.homeManagerConfiguration {
          pkgs = pkgsFor "aarch64-linux";  # Default to ARM (Graviton)
          modules = [ ./home.nix ];
          extraSpecialArgs = {
            username = "ubuntu";
            homeDirectory = "/home/ubuntu";
          };
        };

        # x86_64 variant
        "ubuntu-x86" = home-manager.lib.homeManagerConfiguration {
          pkgs = pkgsFor "x86_64-linux";
          modules = [ ./home.nix ];
          extraSpecialArgs = {
            username = "ubuntu";
            homeDirectory = "/home/ubuntu";
          };
        };
      };

      # Dev shell for working on this config locally
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nixpkgs-fmt
              home-manager
            ];
          };
        }
      );
    };
}
