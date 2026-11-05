# Max for Live Support (Experimental)

AIbleton can attempt to read and modify parameters exposed to Live by a loaded device. The parameters available depend on the device and the Extension Host.

## Create or Edit a File

Tell AIbleton what effect or instrument you want to make. It will attempt to find the corresponding blank template in your local Live installation and save the new file in the `AIbleton/Max Devices` folder in your User Library. If a file with the same name exists, it will choose a different name. You only need to provide a path if automatic discovery fails or you want to use a specific location. When editing an existing device, the tool first reads its objects and connections, then writes the changes to a copy. If no output path is specified, it creates a uniquely named copy beside the source file. Open and test the new file in Max or Live; file operations do not modify instances already loaded in Live.

Currently, only simple AMXD containers and top-level objects are supported: adding and deleting objects, changing object text and position, and connecting or disconnecting lines. Do not use this with frozen devices; containers with declared dependencies or unsupported formats will produce an error. Editing nested patches and custom controls is not yet supported. Audio and MIDI interfaces, object ports, and the resulting sound must still be verified in Max.

A static structural check is returned automatically after creation or editing, and you can also ask AIbleton to check an existing device. The check covers duplicate or missing object IDs, some declared port ranges, parameter ranges, left and right channel reachability in the top-level graph, and some visual window settings. Unrecognized objects are marked as unverified. A file may still be written even if the check reports errors, so correct any issues based on the results. A path in the graph does not prove that audio actually passes through it; nested patches, whether objects actually exist, sound, and window behavior must all be verified separately in Live or Max.

## Edit a Loaded Device in Real Time

Ask AIbleton to prepare a Max bridge for the target device. It will return an instruction for installing a `js` object. Open the device's Max editor in Live, add that object to the target patch, and save it; then return to AIbleton and confirm that installation is complete. Each target device should use its own bridge directory. Bridge files are stored in `~/Documents/AIbleton/MaxBridges`; do not move or delete them while the bridge is still needed.

After installation, you can attempt to list, add, delete, or move objects and connect or disconnect specified ports. Existing objects must have a unique Scripting Name to be targeted for modification; the current inspection cannot list connections. Check and save the device in Max after making changes. If a timeout occurs, the operation may already have been executed, so inspect the actual patch before retrying. Keep Max and the bridge object running; a connection failure will produce an error.

The bridge exchanges messages through local files owned by the current user; protect the bridge directory and device files. This feature has not yet been validated end to end in a real Live/Max environment. The Max version, application permissions, and runtime environment may affect its availability. Start with a copy of a test device, and do not use it on the only copy of important work.
