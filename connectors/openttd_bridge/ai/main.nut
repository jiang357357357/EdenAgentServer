class MonAgentCompany extends AIController {
    function Save() { return {}; }
    function Load(version, data) {}

    function Start() {
        AICompany.SetName("MonAgent Transport");
        while (true) this.Sleep(365 * 74);
    }
}
