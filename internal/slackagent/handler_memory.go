package slackagent

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleMemorySearch(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"summary": h.service.MemorySummary(),
		"results": h.service.SearchLocalMemory(c.Query("q"), limit),
	})
}
