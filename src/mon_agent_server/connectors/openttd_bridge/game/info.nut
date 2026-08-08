class MonAgentBridgeInfo extends GSInfo {
    function GetAuthor()      { return "MonAgent"; }
    function GetName()        { return "MonAgentBridge"; }
    function GetDescription() { return "Structured Admin Port bridge for MonAgent gameplay commands."; }
    function GetVersion()     { return 1; }
    function MinVersionToLoad(){ return 1; }
    function GetDate()        { return "2026-08-07"; }
    function CreateInstance() { return "MonAgentBridge"; }
    function GetShortName()   { return "MABR"; }
    function GetAPIVersion()  { return "15"; }
}

RegisterGS(MonAgentBridgeInfo());
