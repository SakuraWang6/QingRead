#!/usr/bin/env python3
"""Generate the small iOS Xcode project without an external project generator."""
from hashlib import sha1
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def uid(value):
    return sha1(value.encode()).hexdigest()[:24].upper()


def quote(value):
    return json.dumps(str(value), ensure_ascii=False)


def main():
    sources = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "App").rglob("*.swift"))
    if not sources:
        raise SystemExit("No App Swift sources found")
    assets = "App/Assets.xcassets"
    resources = [assets] if (ROOT / assets).exists() else []
    files = sources + resources + ["Config/App.xcconfig"]
    objects = []

    def add(key, body):
        objects.append(f"\t\t{uid(key)} = {{ {body} }};")

    for path in files:
        kind = "sourcecode.swift" if path.endswith(".swift") else "folder.assetcatalog" if path.endswith(".xcassets") else "text.xcconfig"
        add("file:" + path, f"isa = PBXFileReference; lastKnownFileType = {kind}; path = {quote(path)}; sourceTree = SOURCE_ROOT;")
    for path in sources + resources:
        add("build:" + path, f"isa = PBXBuildFile; fileRef = {uid('file:' + path)};")
    add("product", 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = QingRead.app; sourceTree = BUILT_PRODUCTS_DIR;')
    add("root-group", f"isa = PBXGroup; children = ({', '.join(uid('file:' + p) for p in files)}, {uid('products-group')}); sourceTree = \"<group>\";")
    add("products-group", f"isa = PBXGroup; name = Products; children = ({uid('product')}); sourceTree = \"<group>\";")
    add("source-phase", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(uid('build:' + p) for p in sources)}); runOnlyForDeploymentPostprocessing = 0;")
    add("resource-phase", f"isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({', '.join(uid('build:' + p) for p in resources)}); runOnlyForDeploymentPostprocessing = 0;")
    add("core-product", f"isa = XCSwiftPackageProductDependency; package = {uid('local-package')}; productName = ReadingCore;")
    add("core-build", f"isa = PBXBuildFile; productRef = {uid('core-product')};")
    add("framework-phase", f"isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = ({uid('core-build')}); runOnlyForDeploymentPostprocessing = 0;")
    add("local-package", 'isa = XCLocalSwiftPackageReference; relativePath = .;')
    for owner in ["project", "app"]:
        for mode in ["Debug", "Release"]:
            settings = "CLANG_ENABLE_MODULES = YES; SWIFT_VERSION = 5.0;"
            if owner == "project":
                settings += " SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 16.0;"
                if mode == "Debug":
                    settings += " SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;"
                settings += " SWIFT_OPTIMIZATION_LEVEL = \"-Onone\"; DEBUG_INFORMATION_FORMAT = dwarf;" if mode == "Debug" else " SWIFT_OPTIMIZATION_LEVEL = \"-O\"; DEBUG_INFORMATION_FORMAT = \"dwarf-with-dsym\";"
            else:
                settings += " ENABLE_PREVIEWS = YES; LD_RUNPATH_SEARCH_PATHS = \"$(inherited) @executable_path/Frameworks\";"
            base = f"baseConfigurationReference = {uid('file:Config/App.xcconfig')};" if owner == "app" else ""
            add(owner + ":" + mode, f"isa = XCBuildConfiguration; {base} buildSettings = {{ {settings} }}; name = {mode};")
        add(owner + "-configs", f"isa = XCConfigurationList; buildConfigurations = ({uid(owner + ':Debug')}, {uid(owner + ':Release')}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")
    add("app-target", f"isa = PBXNativeTarget; buildConfigurationList = {uid('app-configs')}; buildPhases = ({uid('source-phase')}, {uid('framework-phase')}, {uid('resource-phase')}); buildRules = (); dependencies = (); name = QingRead; packageProductDependencies = ({uid('core-product')}); productName = QingRead; productReference = {uid('product')}; productType = \"com.apple.product-type.application\";")
    add("project", f"isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; TargetAttributes = {{ {uid('app-target')} = {{ CreatedOnToolsVersion = 16.0; }}; }}; }}; buildConfigurationList = {uid('project-configs')}; compatibilityVersion = \"Xcode 14.0\"; developmentRegion = zh-Hans; hasScannedForEncodings = 0; knownRegions = (en, \"zh-Hans\", Base); mainGroup = {uid('root-group')}; packageReferences = ({uid('local-package')}); productRefGroup = {uid('products-group')}; projectDirPath = \"\"; projectRoot = \"\"; targets = ({uid('app-target')});")
    project = ROOT / "QingRead.xcodeproj"
    project.mkdir(exist_ok=True)
    (project / "project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {uid('project')};\n}}\n")
    schemes = project / "xcshareddata" / "xcschemes"
    schemes.mkdir(parents=True, exist_ok=True)
    ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid("app-target")}" BuildableName="QingRead.app" BlueprintName="QingRead" ReferencedContainer="container:QingRead.xcodeproj"/>'
    (schemes / "QingRead.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
    print(f"Generated {project.name}: {len(sources)} Swift files, {len(resources)} resource catalogs")


if __name__ == "__main__":
    main()
